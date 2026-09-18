from __future__ import annotations

from dramaclaw_blender.core.pairing import PairingSession


def test_a_fresh_session_wants_to_poll():
    session = PairingSession(pairing_id="pid", code="ABCD-EFGH", deadline=100.0)

    assert session.should_poll(now=0.0) is True
    assert session.token is None


def test_pending_keeps_polling():
    session = PairingSession(pairing_id="pid", code="ABCD-EFGH", deadline=100.0)

    session.apply({"status": "pending"}, now=5.0)

    assert session.should_poll(now=5.0) is True
    assert session.finished is False


def test_approved_captures_the_token_and_stops():
    session = PairingSession(pairing_id="pid", code="ABCD-EFGH", deadline=100.0)

    session.apply({"status": "approved", "token": "secret"}, now=5.0)

    assert session.token == "secret"
    assert session.finished is True
    assert session.error is None
    assert session.should_poll(now=5.0) is False


def test_expired_stops_with_a_message_the_user_can_act_on():
    session = PairingSession(pairing_id="pid", code="ABCD-EFGH", deadline=100.0)

    session.apply({"status": "expired"}, now=5.0)

    assert session.finished is True
    assert "重新" in session.error


def test_consumed_stops_too():
    # 同一个 pairing_id 被兑过了——多半是用户点了两次「连接」。
    session = PairingSession(pairing_id="pid", code="ABCD-EFGH", deadline=100.0)

    session.apply({"status": "consumed"}, now=5.0)

    assert session.finished is True
    assert session.error


def test_polling_stops_at_the_deadline_even_if_the_server_keeps_saying_pending():
    session = PairingSession(pairing_id="pid", code="ABCD-EFGH", deadline=100.0)
    session.apply({"status": "pending"}, now=99.0)

    assert session.should_poll(now=101.0) is False
    assert session.finished is True
    assert session.error


def test_a_transport_failure_does_not_end_the_session():
    # 网抖一下不该让用户重开配对——码还没过期，接着试。
    session = PairingSession(pairing_id="pid", code="ABCD-EFGH", deadline=100.0)

    session.fail_once("连不上服务器")

    assert session.finished is False
    assert session.should_poll(now=5.0) is True


def test_enough_consecutive_failures_do_end_it():
    session = PairingSession(pairing_id="pid", code="ABCD-EFGH", deadline=100.0)

    for _ in range(PairingSession.MAX_CONSECUTIVE_FAILURES):
        session.fail_once("连不上服务器")

    assert session.finished is True
    assert "连不上服务器" in session.error


def test_one_success_resets_the_failure_streak():
    session = PairingSession(pairing_id="pid", code="ABCD-EFGH", deadline=100.0)
    for _ in range(PairingSession.MAX_CONSECUTIVE_FAILURES - 1):
        session.fail_once("连不上服务器")

    session.apply({"status": "pending"}, now=5.0)
    session.fail_once("连不上服务器")

    assert session.finished is False


def test_approved_without_a_token_is_an_error_not_a_silent_nothing():
    # 服务端说批了却没给令牌。以前这里产出 token="" + finished=True + error=None，
    # UI 那边空串为假，于是用户看到的是「什么都没发生」。
    session = PairingSession(pairing_id="pid", code="ABCD-EFGH", deadline=100.0)

    session.apply({"status": "approved"}, now=5.0)

    assert session.finished is True
    assert not session.token
    assert session.error
    assert "重新" in session.error


def test_approved_with_an_empty_token_is_treated_the_same():
    session = PairingSession(pairing_id="pid", code="ABCD-EFGH", deadline=100.0)

    session.apply({"status": "approved", "token": ""}, now=5.0)

    assert session.finished is True
    assert not session.token
    assert session.error


def test_every_way_a_session_can_end_badly_leaves_something_to_show_the_user():
    # UI 只有 error 这一个出口。任何「结束了但没拿到令牌」的路径都必须填上它，
    # 否则面板上一个字都不会变。
    endings = [
        lambda s: s.apply({"status": "expired"}, now=5.0),
        lambda s: s.apply({"status": "consumed"}, now=5.0),
        lambda s: s.apply({"status": "approved"}, now=5.0),
        lambda s: s.should_poll(now=101.0),
        lambda s: [s.fail_once("连不上服务器") for _ in range(s.MAX_CONSECUTIVE_FAILURES)],
    ]
    for end in endings:
        session = PairingSession(pairing_id="pid", code="ABCD-EFGH", deadline=100.0)
        end(session)
        assert session.finished is True
        assert not session.token
        assert session.error, end
