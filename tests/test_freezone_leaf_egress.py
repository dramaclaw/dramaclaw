from types import SimpleNamespace

from novelvideo.task_backend.runners import freezone


def test_network_leaf_uses_organization_context_only(monkeypatch):
    platform_context = SimpleNamespace(is_organization=False)
    monkeypatch.setattr(
        freezone,
        "_extract_trusted_egress_context",
        lambda _envelope: platform_context,
    )

    def leaf(**kwargs):
        return kwargs

    assert freezone._call_freezone_leaf({}, leaf, "generate_freezone_audio_eleven_music") == {}


def test_network_leaf_passes_organization_context(monkeypatch):
    organization_context = SimpleNamespace(is_organization=True)
    monkeypatch.setattr(
        freezone,
        "_extract_trusted_egress_context",
        lambda _envelope: organization_context,
    )

    def leaf(**kwargs):
        return kwargs

    assert freezone._call_freezone_leaf(
        {}, leaf, "generate_freezone_audio_eleven_music"
    ) == {"egress_context": organization_context}
