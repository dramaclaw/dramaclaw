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
