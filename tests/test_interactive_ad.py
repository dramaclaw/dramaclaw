import pytest
from pydantic import ValidationError
from novelvideo.interactive_story.models import StoryDraftV2, StoryCallToAction, StoryChoiceInteraction
from novelvideo.interactive_story.canvas_mapper import project_story_to_canvas, story_from_canvas


def test_ad_gesture_and_cta_round_trip():
    story = StoryDraftV2.model_validate({
        "story_id": "ad", "title": "汽车广告", "start_segment_id": "idle",
        "segments": [
            {"id": "idle", "title": "启动", "script": "长按启动"},
            {"id": "end", "title": "预约", "script": "真实试驾", "kind": "ending", "ending_label": "试驾", "cta": {"label": "预约试驾", "url": "https://example.com/book"}},
        ],
        "choices": [{"id": "hold", "source_segment_id": "idle", "target_segment_id": "end", "text": "启动", "order": 0,
                     "interaction": {"trigger": "hold", "hold_ms": 1200}}],
    })
    projection = project_story_to_canvas(story)
    restored = story_from_canvas({"nodes": projection.nodes, "edges": projection.edges}, "ad")
    assert restored.choices[0].interaction.trigger == "hold"
    assert restored.choices[0].interaction.hold_ms == 1200
    assert restored.segments[-1].cta == story.segments[-1].cta


@pytest.mark.parametrize("url", ["javascript:alert(1)", "//example.com", "http://example.com", "https://user:secret@example.com"])
def test_cta_rejects_unsafe_destinations(url):
    with pytest.raises(ValidationError):
        StoryCallToAction(label="预约", url=url)


def test_unconfigured_cta_is_an_explicit_draft():
    assert StoryCallToAction(label="预约").url == ""


@pytest.mark.parametrize("trigger", ["swipe_left", "swipe_right"])
def test_removed_swipe_triggers_are_rejected(trigger):
    with pytest.raises(ValidationError):
        StoryChoiceInteraction(trigger=trigger)
