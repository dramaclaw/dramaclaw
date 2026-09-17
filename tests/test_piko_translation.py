import asyncio
from contextlib import asynccontextmanager

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from novelvideo.api.routes import piko
from novelvideo.piko import translation


def result(text="你好", target="zh"):
    return translation.Translation(translated_text=text, source_language="en", target_language=target)


@pytest.mark.asyncio
async def test_cache_isolates_users_conversations_languages_and_deduplicates(monkeypatch):
    calls = []
    async def translate(text, target):
        calls.append((text, target))
        await asyncio.sleep(0)
        return result(text, target)
    monkeypatch.setattr(translation, "translate_message", translate)
    cache = translation.TranslationCache()
    await asyncio.gather(*(cache.get("u1", "private:a", "hi", "zh") for _ in range(3)))
    await cache.get("u1", "private:a", "hi", "zh")
    assert len(calls) == 1
    for user, scope, target in [("u2", "private:a", "zh"), ("u1", "private:b", "zh"), ("u1", "private:a", "en")]:
        await cache.get(user, scope, "hi", target)
    assert len(calls) == 4
    assert not cache.pending


@pytest.mark.asyncio
async def test_failures_retry_and_requests_are_limited(monkeypatch):
    calls = 0
    async def translate(text, target):
        nonlocal calls
        calls += 1
        if calls == 1:
            raise RuntimeError("provider private details")
        return result(text, target)
    monkeypatch.setattr(translation, "translate_message", translate)
    cache = translation.TranslationCache()
    with pytest.raises(RuntimeError):
        await cache.get("u", "public", "hi", "zh")
    assert not cache.pending and not cache.results
    await cache.get("u", "public", "hi", "zh")
    for index in range(18):
        await cache.get("u", "public", str(index), "zh")
    with pytest.raises(translation.TranslationBusy):
        await cache.get("u", "public", "another", "zh")
    assert (await cache.get("u", "public", "hi", "zh")).translated_text == "hi"


@pytest.fixture
def client(monkeypatch):
    app = FastAPI()
    app.include_router(piko.router)
    app.dependency_overrides[piko.get_api_user] = lambda: {"user_id": "u1", "username": "alice"}
    @asynccontextmanager
    async def scope(**kwargs):
        assert kwargs["requester_user_id"] == "u1"
        yield None
    monkeypatch.setattr(piko, "request_egress_scope", scope)
    monkeypatch.setattr(piko, "_cache", translation.TranslationCache())
    with TestClient(app) as client:
        yield client


def test_route_contract_and_validation(client, monkeypatch):
    calls = []
    async def translate(text, target):
        calls.append((text, target))
        return result("你好", target)
    monkeypatch.setattr(translation, "translate_message", translate)
    body = {"text": "hi", "target_language": "zh", "conversation": "private:a"}
    assert client.post("/piko/chat/translate", json=body).json()["translated_text"] == "你好"
    for update in [{"text": " "}, {"text": "x" * 81}, {"target_language": "fr"}, {"api_key": "forbidden"}]:
        assert client.post("/piko/chat/translate", json={**body, **update}).status_code == 422
    assert calls == [("hi", "zh")]


def test_provider_errors_are_sanitized(client, monkeypatch):
    async def fail(*args):
        raise RuntimeError("secret provider detail")
    monkeypatch.setattr(translation, "translate_message", fail)
    response = client.post("/piko/chat/translate", json={"text": "hi", "target_language": "en", "conversation": "public"})
    assert response.status_code == 502
    assert response.json() == {"detail": "translation_unavailable"}


def test_authentication_required(client):
    def deny():
        raise HTTPException(401)
    client.app.dependency_overrides[piko.get_api_user] = deny
    assert client.post("/piko/chat/translate", json={"text": "hi", "target_language": "zh", "conversation": "public"}).status_code == 401


@pytest.mark.asyncio
async def test_cache_expires(monkeypatch):
    clock = [100.0]
    monkeypatch.setattr(translation, "monotonic", lambda: clock[0])
    calls = []
    async def translate(text, target):
        calls.append(text)
        return result(text, target)
    monkeypatch.setattr(translation, "translate_message", translate)
    cache = translation.TranslationCache()
    await cache.get("u", "c", "hi", "zh")
    clock[0] += 301
    await cache.get("u", "c", "hi", "zh")
    assert calls == ["hi", "hi"]


def test_gateway_authorization_precedes_translation(client, monkeypatch):
    @asynccontextmanager
    async def reject(**kwargs):
        raise HTTPException(403, "denied")
        yield
    monkeypatch.setattr(piko, "request_egress_scope", reject)
    response = client.post("/piko/chat/translate", json={"text": "hi", "target_language": "zh", "conversation": "public"})
    assert response.status_code == 403
    assert not piko._cache.pending and not piko._cache.results


def test_timeout_and_throttle_contract(client, monkeypatch):
    async def timeout(*args):
        raise TimeoutError()
    monkeypatch.setattr(piko._cache, "get", timeout)
    body = {"text": "hi", "target_language": "zh", "conversation": "public"}
    assert client.post("/piko/chat/translate", json=body).status_code == 504
    async def busy(*args):
        raise translation.TranslationBusy()
    monkeypatch.setattr(piko._cache, "get", busy)
    response = client.post("/piko/chat/translate", json=body)
    assert response.status_code == 429
    assert response.headers["Retry-After"] == "10"
