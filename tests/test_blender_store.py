from __future__ import annotations

import time

import pytest

from novelvideo import blender_store


@pytest.fixture()
def db(tmp_path):
    path = tmp_path / "blender.db"
    blender_store.init_db(path)
    return path


def test_create_pairing_returns_a_readable_code_and_an_opaque_id(db):
    pairing = blender_store.create_pairing(db)

    # 码要用户照着念/敲，所以短、分组、没有易混字符。
    assert len(pairing.code) == 9 and pairing.code[4] == "-"
    assert set(pairing.code) <= set("ABCDEFGHJKLMNPQRSTUVWXYZ23456789-")
    # pairing_id 是插件轮询时的**凭证**，必须够长到猜不出来。
    assert len(pairing.pairing_id) >= 32


def test_pending_pairing_has_no_token_yet(db):
    pairing = blender_store.create_pairing(db)

    result = blender_store.consume_pairing(db, pairing.pairing_id)

    assert result.status == "pending"
    assert result.token is None


def test_approved_pairing_hands_out_a_token_once(db):
    pairing = blender_store.create_pairing(db)
    assert blender_store.approve_pairing(db, pairing.code, user_id="alice") is True

    first = blender_store.consume_pairing(db, pairing.pairing_id)
    assert first.status == "approved"
    assert first.token
    assert first.user_id == "alice"

    # 第二次问同一个 pairing_id 什么都拿不到：令牌只兑一次，
    # 轮询日志/代理缓存里留下的 pairing_id 就不再是一把钥匙。
    second = blender_store.consume_pairing(db, pairing.pairing_id)
    assert second.status == "consumed"
    assert second.token is None


def test_approving_an_unknown_code_fails(db):
    assert blender_store.approve_pairing(db, "ZZZZ-ZZZZ", user_id="alice") is False


def test_approving_twice_fails(db):
    pairing = blender_store.create_pairing(db)
    assert blender_store.approve_pairing(db, pairing.code, user_id="alice") is True
    assert blender_store.approve_pairing(db, pairing.code, user_id="bob") is False


def test_code_matching_ignores_case_and_spaces(db):
    pairing = blender_store.create_pairing(db)
    typed = f"  {pairing.code.lower().replace('-', ' - ')} "

    assert blender_store.approve_pairing(db, typed, user_id="alice") is True


def test_expired_pairing_cannot_be_approved(db, monkeypatch):
    pairing = blender_store.create_pairing(db)
    later = time.time() + blender_store.PAIRING_TTL_SECONDS + 1
    monkeypatch.setattr(blender_store, "_now", lambda: int(later))

    assert blender_store.approve_pairing(db, pairing.code, user_id="alice") is False


def test_expired_pairing_reports_expired_to_the_plugin(db, monkeypatch):
    pairing = blender_store.create_pairing(db)
    later = time.time() + blender_store.PAIRING_TTL_SECONDS + 1
    monkeypatch.setattr(blender_store, "_now", lambda: int(later))

    assert blender_store.consume_pairing(db, pairing.pairing_id).status == "expired"


def test_unknown_pairing_id_reports_expired_not_pending(db):
    # 不给「这个 id 不存在」和「还没批」两种不同回答，免得成了枚举 oracle。
    assert blender_store.consume_pairing(db, "no-such-id").status == "expired"


def test_init_db_is_idempotent(db):
    blender_store.init_db(db)
    blender_store.init_db(db)

    assert blender_store.create_pairing(db).code
