"""Real dispatcher and SDK streams: partial answers never become adopted documents."""

import asyncio
import json

import httpx
import pytest
from openai import AsyncOpenAI
from pydantic_ai.models.openai import OpenAIChatModel
from pydantic_ai.providers.openai import OpenAIProvider

from novelvideo.director import dispatch, writing
from novelvideo.director.execution import execution_capability
from novelvideo.director.execution_repository import identifier
from novelvideo.director.schemas.execution import ExecutionCommand, ExecutionFault
from novelvideo.director.streaming import VisibleText
from tests.director.test_execution import runtime as runtime


def queue_episode(store, work, service, instruction="Write this episode.", tokens=2048):
    ordinal = store.get_work(work["id"])["current_episode"]
    key = f"episode-{ordinal:03d}"

    def send(payload):
        intent = identifier()
        return service.execute("stream-test", ExecutionCommand.from_wire({
            "schemaVersion": 2, "commandId": intent, "clientRequestId": intent,
            "sessionId": "stream-test", "workId": work["id"],
            "expected": {"workRevision": store.get_work(work["id"])["revision"],
                         "documentVersions": {key: store.get_document(work["id"], key)["version"]},
                         "capabilityVersion": execution_capability()["version"]},
            "payload": payload,
        }))["result"]

    quote = send({"type": "cost.quote", "kind": "episode", "episodeOrdinal": ordinal,
                  "instruction": instruction, "maxOutputTokens": tokens})
    return quote, send({"type": "approval.grant", "quoteId": quote["quoteId"],
                        "requestHash": quote["requestHash"], "unknownCostConsent": True})


@pytest.mark.parametrize("chunks,expected", [
    (["<thi", "nk>secret", "</thi", "nk># 文", "字"], "# 文字"),
    (["# Body", "<think>hidden</think>", " end"], "# Body end"),
    (["<think>unclosed"], ""), (["<thi"], ""), (["2 < 3"], "2 < 3"),
])
def test_visible_text(chunks, expected):
    visible = VisibleText()
    assert "".join(visible.feed(part) for part in chunks) + visible.feed("", final=True) == expected


@pytest.mark.parametrize("outcome", ["success", "disconnect", "cancel", "length"])
async def test_durable_deltas_and_terminal_safety(runtime, monkeypatch, outcome):
    store, work, _, repo, service = runtime
    quote, run = queue_episode(store, work, service)
    assert quote["parameters"]["stream"] is True
    calls = []

    async def model(_prompt, _name, _tokens, *, on_delta):
        calls.append(1)
        await on_delta("# Draft\n\n")
        assert store.get_document(work["id"], "episode-001")["version"] == 0
        assert not store.list_changes(work["id"])
        events = repo.events(work["id"])["events"]
        assert events[-1]["type"] == "text.delta"
        assert not repo.events(work["id"], events[-1]["seq"])["events"]
        if outcome == "disconnect":
            raise ConnectionError("secret provider data")
        if outcome == "cancel":
            with repo.transaction() as db:
                db.execute("UPDATE director_operations SET status='cancel_requested' WHERE id=?", (run["id"],))
        await on_delta("Visible action.")
        return writing.WritingResult("# Draft\n\nVisible action.", 100, 20, 1,
                                     "length" if outcome == "length" else "stop", "test-model")

    monkeypatch.setattr(dispatch, "run_bounded_writing_model", model)
    result = await dispatch.dispatch_writing(repo, work["id"], run["id"])
    assert result["status"] == {"success": "succeeded", "disconnect": "unknown", "cancel": "cancelled", "length": "failed"}[outcome]
    assert store.get_document(work["id"], "episode-001")["version"] == 0
    assert bool(store.list_changes(work["id"])) is (outcome == "success")
    assert await dispatch.dispatch_writing(repo, work["id"], run["id"]) is None
    assert calls == [1]
    assert "secret" not in json.dumps(repo.events(work["id"]))
    if outcome == "success":
        assert result["response"]["episodeFormat"]["qualityVerified"] is False
    if outcome == "length":
        assert result["errorCode"] == "MODEL_OUTPUT_TRUNCATED"


def test_progress_requires_lease_and_stops_after_terminal(runtime):
    store, work, _, repo, service = runtime
    _, run = queue_episode(store, work, service)
    token, _ = repo.claim(work["id"], run["id"])
    with pytest.raises(ExecutionFault):
        repo.progress(work["id"], run["id"], "bad", "text.delta", {"text": "x"})
    repo.complete(work["id"], run["id"], token, output="draft")
    assert repo.progress(work["id"], run["id"], token, "text.delta", {"text": "late"}) == 0


@pytest.mark.parametrize("model_name", ["test-model", "ark::doubao-seed-evolving", "ark::deepseek-v4.1-flash"])
async def test_sdk_wire_stream_and_usage(monkeypatch, model_name):
    requests = []

    class Body(httpx.AsyncByteStream):
        async def __aiter__(self):
            for text in ["<thi", "nk>hidden</think>", "# Episode\n", "Visible action."]:
                chunk = {"id": "synthetic", "object": "chat.completion.chunk", "created": 0,
                         "model": "test-model", "choices": [{"index": 0, "delta": {"content": text}, "finish_reason": None}],
                         "usage": {"prompt_tokens": 120, "completion_tokens": 10, "total_tokens": 130}}
                yield ("data: " + json.dumps(chunk) + "\n\n").encode()
                await asyncio.sleep(0.06)
            yield ('data: ' + json.dumps({"id": "synthetic", "object": "chat.completion.chunk", "created": 0,
                   "model": "test-model", "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
                   "usage": {"prompt_tokens": 120, "completion_tokens": 18, "total_tokens": 138}}) + '\n\ndata: [DONE]\n\n').encode()

    async def transport(request):
        requests.append(json.loads(request.content))
        return httpx.Response(200, headers={"content-type": "text/event-stream"}, stream=Body())

    async with httpx.AsyncClient(transport=httpx.MockTransport(transport)) as http:
        client = AsyncOpenAI(api_key="synthetic", base_url="https://synthetic.invalid/v1", http_client=http, max_retries=0)
        model = OpenAIChatModel(model_name, provider=OpenAIProvider(openai_client=client))
        monkeypatch.setattr(writing, "get_newapi_text_pydantic_model", lambda *a, **k: model)
        deltas = []

        async def collect(text):
            deltas.append(text)

        result = await writing.run_bounded_writing_model("write", model_name, 512, on_delta=collect)
    assert len(requests) == 1 and requests[0]["stream"] is True
    assert requests[0]["stream_options"]["continuous_usage_stats"] is True
    if model_name.startswith("ark::"):
        assert "max_completion_tokens" not in requests[0]
    else:
        assert requests[0]["max_completion_tokens"] == 512
    assert requests[0]["max_tokens"] == 512
    assert result.text == "".join(deltas) == "# Episode\nVisible action."
    assert (result.input_tokens, result.output_tokens, result.requests) == (120, 18, 1)
    assert result.finish_reason == "stop"
