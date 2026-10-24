from concurrent.futures import ThreadPoolExecutor
import hashlib
from pathlib import Path

import pytest


def resource(tmp_path):
    path = tmp_path / 'candidate.wav'
    path.write_bytes(b'complete 4.1 second two speaker candidate')
    return {'media_path': path.name, 'media_hash': hashlib.sha256(path.read_bytes()).hexdigest(),
            'duration_us': 4_100_000, 'has_audio': True}


SCOPE = {'owner_type': 'user', 'owner_id': 'owner', 'project_id': 'project',
         'canvas_id': 'canvas', 'access_model': 'shared', 'private_owner_id': ''}


def test_complete_source_and_restart_dedupe_ignores_target_script(tmp_path):
    from novelvideo.freezone.remix.source_speech import observe_source_speech
    from novelvideo.freezone.remix.store import RemixArtifactStore
    media = resource(tmp_path)
    calls = []
    class Engine:
        def transcribe(self, path, language):
            calls.append(path.read_bytes())
            return {'status': 'completed', 'transcript': 'one two', 'words': [
                {'text': 'one', 'start': 0, 'end': 1},
                {'text': 'two', 'start': 3.2, 'end': 4.1}]}
    store = RemixArtifactStore(tmp_path, 'project')
    first = observe_source_speech(store, scope=SCOPE, resource=media, language='en',
                                  provider_signature='provider-one', aligner=Engine())
    second = observe_source_speech(RemixArtifactStore(tmp_path, 'project'), scope=SCOPE,
        resource=media, language='en', provider_signature='provider-one', aligner=Engine())
    assert first == second
    saved = store.read(first['artifact_id'], first['revision'])
    assert saved['payload']['source_duration_us'] == 4_100_000
    assert saved['payload']['recognized_words'][-1]['end_us'] == 4_100_000
    assert len(calls) == 1
    assert saved['payload']['timing_granularity'] == 'word'
    assert 'audio_reviewed' not in saved['payload']


def test_scopes_provider_changes_and_file_replacement_do_not_reuse(tmp_path):
    from novelvideo.freezone.remix.source_speech import observe_source_speech
    from novelvideo.freezone.remix.store import RemixArtifactStore
    media = resource(tmp_path)
    store = RemixArtifactStore(tmp_path, 'project')
    calls = []
    class Engine:
        def transcribe(self, path, language):
            calls.append(1)
            return {'status': 'no_speech', 'words': []}
    def observe(scope=SCOPE, provider='p'):
        return observe_source_speech(store, scope=scope, resource=media, language='en',
                                    provider_signature=provider, aligner=Engine())
    first = observe()
    assert observe() == first
    observe({**SCOPE, 'canvas_id': 'private-other', 'access_model': 'private', 'private_owner_id': 'other'})
    observe(provider='new-config')
    (tmp_path / media['media_path']).write_bytes(b'replaced')
    with pytest.raises(ValueError, match='changed'):
        observe()
    media['media_hash'] = hashlib.sha256(b'replaced').hexdigest()
    observe()
    assert len(calls) == 4


def test_concurrent_workers_claim_provider_once(tmp_path):
    from novelvideo.freezone.remix.source_speech import observe_source_speech, SourceSpeechPending
    from novelvideo.freezone.remix.store import RemixArtifactStore
    from threading import Event
    media = resource(tmp_path)
    started, release = Event(), Event()
    calls = []
    class Engine:
        def transcribe(self, path, language):
            calls.append(1); started.set()
            assert release.wait(5)
            return {'status': 'no_speech', 'words': []}
    def run():
        return observe_source_speech(RemixArtifactStore(tmp_path, 'project'), scope=SCOPE,
             resource=media, language='en', provider_signature='p', aligner=Engine())
    with ThreadPoolExecutor(2) as pool:
        first = pool.submit(run)
        assert started.wait(5)
        second = pool.submit(run)
        with pytest.raises(SourceSpeechPending):
            second.result(5)
        release.set()
        assert first.result(5)['revision'] == 1
    assert len(calls) == 1


def test_timeout_is_durable_and_never_repeats_unknown_provider(tmp_path):
    from novelvideo.freezone.remix.source_speech import observe_source_speech, SourceSpeechPending
    from novelvideo.freezone.remix.store import RemixArtifactStore
    media = resource(tmp_path)
    calls = []
    class Engine:
        def transcribe(self, path, language):
            calls.append(1)
            raise TimeoutError('provider outcome unknown')
    kwargs = dict(scope=SCOPE, resource=media, language='en', provider_signature='p', aligner=Engine())
    with pytest.raises(TimeoutError):
        observe_source_speech(RemixArtifactStore(tmp_path, 'project'), **kwargs)
    with pytest.raises(SourceSpeechPending):
        observe_source_speech(RemixArtifactStore(tmp_path, 'project'), **kwargs)
    assert len(calls) == 1


def test_unresolved_claim_is_visible_until_a_result_is_saved(tmp_path):
    from novelvideo.freezone.remix.source_speech import (observe_source_speech, source_speech_key,
        unresolved_source_speech_claim)
    from novelvideo.freezone.remix.store import RemixArtifactStore
    media = resource(tmp_path)
    store = RemixArtifactStore(tmp_path, 'project')
    class Engine:
        def transcribe(self, path, language):
            return {'status': 'completed', 'transcript': 'one', 'words': [
                {'text': 'one', 'start': 0, 'end': 4.1}]}
    key = source_speech_key(scope=SCOPE, media_hash=media['media_hash'], stream_index=0,
                            language='en', provider_signature='p')
    assert unresolved_source_speech_claim(store, key) is None
    with pytest.raises(TimeoutError):
        observe_source_speech(store, scope=SCOPE, resource=media, language='en',
                              provider_signature='p', aligner=type('E', (), {
                                  'transcribe': lambda *_: (_ for _ in ()).throw(TimeoutError('unknown'))})())
    assert unresolved_source_speech_claim(store, key) == 'unknown'
    observe_source_speech(store, scope=SCOPE, resource=media, language='en',
                          provider_signature='p2', aligner=Engine())
    resolved = source_speech_key(scope=SCOPE, media_hash=media['media_hash'], stream_index=0,
                                 language='en', provider_signature='p2')
    assert unresolved_source_speech_claim(store, resolved) is None


def test_segment_recognition_has_no_fabricated_word_times(tmp_path):
    from novelvideo.freezone.remix.source_speech import observe_source_speech
    from novelvideo.freezone.remix.store import RemixArtifactStore
    class Engine:
        def transcribe(self, path, language):
            return {'status': 'completed', 'transcript': 'whole sentence', 'words': [],
                    'segments': [{'text': 'whole sentence', 'start': 0.1, 'end': 4.1}]}
    store = RemixArtifactStore(tmp_path, 'project')
    ref = observe_source_speech(store, scope=SCOPE, resource=resource(tmp_path),
                               language='en', provider_signature='p', aligner=Engine())
    payload = store.read(ref['artifact_id'], 1)['payload']
    assert payload['recognized_words'] == []
    assert payload['recognized_segments'][0]['end_us'] == 4_100_000
    assert payload['timing_granularity'] == 'segment'


def test_missing_audio_and_no_speech_are_distinct(tmp_path):
    from novelvideo.freezone.remix.source_speech import observe_source_speech
    from novelvideo.freezone.remix.store import RemixArtifactStore
    class Never:
        def transcribe(self, *args):
            pytest.fail('missing audio must not call provider')
    media = resource(tmp_path); media['has_audio'] = False
    store = RemixArtifactStore(tmp_path, 'project')
    ref = observe_source_speech(store, scope=SCOPE, resource=media, language='en', provider_signature='p', aligner=Never())
    assert store.read(ref['artifact_id'], 1)['payload']['status'] == 'missing_audio'


def test_native_newapi_segment_mode_is_opt_in(tmp_path):
    import httpx
    from novelvideo.freezone.remix.newapi_transcription import NewApiSpeechTranscriber
    media = tmp_path / 'audio.wav'; media.write_bytes(b'audio')
    def respond(request):
        return httpx.Response(200, json={'text': 'whole sentence', 'segments': [
            {'text': 'whole sentence', 'start': 0.1, 'end': 4.1}]})
    transport = httpx.MockTransport(respond)
    with pytest.raises(RuntimeError, match='word timestamps'):
        NewApiSpeechTranscriber(api_key='secret', base_url='https://test/v1', transport=transport).transcribe(media, 'en')
    result = NewApiSpeechTranscriber(api_key='secret', base_url='https://test/v1',
                                    transport=transport, allow_segments=True).transcribe(media, 'en')
    assert result['words'] == []
    assert result['segments'][0]['end'] == 4.1


def test_publication_failure_recovers_durable_recognition_without_provider_retry(tmp_path, monkeypatch):
    from novelvideo.freezone.remix.source_speech import observe_source_speech
    from novelvideo.freezone.remix.store import RemixArtifactStore
    media = resource(tmp_path); calls = []
    class Engine:
        def transcribe(self, path, language):
            calls.append(1)
            return {'status': 'no_speech', 'words': []}
    original = RemixArtifactStore._publish
    failures = []
    def interrupted(self, **kwargs):
        result = original(self, **kwargs)
        if not failures:
            failures.append(True)
            raise OSError('crashed after artifact publication')
        return result
    monkeypatch.setattr(RemixArtifactStore, '_publish', interrupted)
    kwargs = dict(scope=SCOPE, resource=media, language='en', provider_signature='p', aligner=Engine())
    with pytest.raises(OSError):
        observe_source_speech(RemixArtifactStore(tmp_path, 'project'), **kwargs)
    ref = observe_source_speech(RemixArtifactStore(tmp_path, 'project'), **kwargs)
    directories = list((tmp_path / 'freezone' / '_remix_artifacts').iterdir())
    assert len([d for d in directories if d.is_dir()]) == 1
    assert len(calls) == 1
    assert ref['revision'] == 1


def test_source_validator_rechecks_producer_scope_and_file(tmp_path):
    from novelvideo.freezone.remix.source_speech import observe_source_speech, read_source_speech_observation
    from novelvideo.freezone.remix.store import RemixArtifactStore
    media = resource(tmp_path)
    class Engine:
        def transcribe(self, *args):
            return {'status': 'no_speech', 'words': []}
    store = RemixArtifactStore(tmp_path, 'project')
    kwargs = dict(scope=SCOPE, resource=media, language='en', provider_signature='p')
    ref = observe_source_speech(store, **kwargs, aligner=Engine())
    assert read_source_speech_observation(store, ref, **kwargs)['payload']['status'] == 'no_speech_detected'
    with pytest.raises(ValueError, match='provenance'):
        read_source_speech_observation(store, ref, **{**kwargs, 'scope': {**SCOPE, 'canvas_id': 'different'}})
    forged = store.create('source_speech_observation.v1', store.read(ref['artifact_id'], 1)['payload'], [])
    with pytest.raises(ValueError, match='provenance'):
        read_source_speech_observation(store, {'artifact_id': forged['id'], 'revision': 1}, **kwargs)
    (tmp_path / media['media_path']).write_bytes(b'changed')
    with pytest.raises(ValueError, match='changed'):
        read_source_speech_observation(store, ref, **kwargs)
