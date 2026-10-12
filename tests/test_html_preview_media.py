from novelvideo.freezone import preview_media as grants


def test_grant_is_bound_to_resource_project_artifact_and_expiry(tmp_path, monkeypatch):
    monkeypatch.setattr(grants.time, 'time', lambda: 1000)
    key = grants.project_key(tmp_path, create=True)
    assert grants.project_key(tmp_path, create=True) == key
    token = grants.signature(key, 'p', 'a', 'videos/clip.mp4', 1900)
    assert grants.verify(key, 'p', 'a', 'videos/clip.mp4', 1900, token)
    assert not grants.verify(key, 'peer', 'a', 'videos/clip.mp4', 1900, token)
    assert not grants.verify(key, 'p', 'b', 'videos/clip.mp4', 1900, token)
    assert not grants.verify(key, 'p', 'a', 'other.mp4', 1900, token)
    monkeypatch.setattr(grants.time, 'time', lambda: 1900)
    assert not grants.verify(key, 'p', 'a', 'videos/clip.mp4', 1900, token)
