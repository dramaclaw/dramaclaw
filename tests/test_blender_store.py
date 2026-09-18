from __future__ import annotations

import time

import pytest

from novelvideo import blender_store


@pytest.fixture()
def db(tmp_path):
    path = tmp_path / "blender.db"
    blender_store.init_db(path)
    return path


def _pairing_rows(db_path) -> int:
    import sqlite3

    conn = sqlite3.connect(db_path)
    try:
        return conn.execute("SELECT COUNT(*) FROM blender_pairings").fetchone()[0]
    finally:
        conn.close()


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


def test_second_approval_does_not_hijack_the_first(db):
    # 这是整个模块最重要的不变量：先到先得。原来只断言第二次返回 False，
    # 没人守着「approved_user 还是 alice」，守卫被改掉测试也不会红。
    pairing = blender_store.create_pairing(db)
    assert blender_store.approve_pairing(db, pairing.code, user_id="alice") is True
    assert blender_store.approve_pairing(db, pairing.code, user_id="bob") is False

    assert blender_store.consume_pairing(db, pairing.pairing_id).user_id == "alice"


def test_pairing_that_expires_between_approve_and_consume_is_expired(db, monkeypatch):
    pairing = blender_store.create_pairing(db)
    assert blender_store.approve_pairing(db, pairing.code, user_id="alice") is True

    later = time.time() + blender_store.PAIRING_TTL_SECONDS + 1
    monkeypatch.setattr(blender_store, "_now", lambda: int(later))

    result = blender_store.consume_pairing(db, pairing.pairing_id)
    assert result.status == "expired"
    assert result.token is None


def test_purge_removes_expired_pairings_whatever_their_status(db, monkeypatch):
    # 批了但没兑的配对同样是垃圾：它已经兑不出令牌了，却永久占着 code_hash。
    approved = blender_store.create_pairing(db)
    blender_store.approve_pairing(db, approved.code, user_id="alice")
    blender_store.create_pairing(db)

    later = time.time() + blender_store.PAIRING_TTL_SECONDS + 1
    monkeypatch.setattr(blender_store, "_now", lambda: int(later))
    blender_store.purge_expired(db)

    assert _pairing_rows(db) == 0


def test_purge_keeps_live_pairings(db):
    blender_store.create_pairing(db)
    blender_store.purge_expired(db)

    assert _pairing_rows(db) == 1


def test_store_works_on_a_database_nobody_initialised(tmp_path):
    # 容器重建把 state 卷清空后，第一个到达的往往是插件的轮询而不是建配对。
    fresh = tmp_path / "never-touched" / "blender.db"

    assert blender_store.consume_pairing(fresh, "whatever").status == "expired"
    assert blender_store.approve_pairing(fresh, "ABCD-EFGH", user_id="alice") is False
    blender_store.purge_expired(fresh)


def test_approving_with_a_blank_user_fails(db):
    pairing = blender_store.create_pairing(db)

    assert blender_store.approve_pairing(db, pairing.code, user_id="") is False
    assert blender_store.consume_pairing(db, pairing.pairing_id).status == "pending"


def test_typos_outside_the_alphabet_are_rejected_not_corrected(db):
    # 字母表排除 0/O/1/I/L 就是为了照顾易混字符。用户真敲了这些，说明他看错了，
    # 应该告诉他码不对，而不是悄悄剔掉再拼出另一个合法码。
    assert blender_store.normalize_code("ABCD-EFGH") == "ABCD-EFGH"
    assert blender_store.normalize_code("  abcd - efgh ") == "ABCD-EFGH"
    assert blender_store.normalize_code("0ABCD-EFGH") == ""
    assert blender_store.normalize_code("ABCD-EFGHI") == ""
    assert blender_store.normalize_code("ABCO-DEFG") == ""
    assert blender_store.normalize_code("") == ""
    assert blender_store.normalize_code(None) == ""


def test_no_plaintext_secret_ever_lands_in_the_database(db):
    # 这个模块的核心主张，值得有人守着而不是靠人眼。
    pairing = blender_store.create_pairing(db)
    blender_store.approve_pairing(db, pairing.code, user_id="alice")
    token = blender_store.consume_pairing(db, pairing.pairing_id).token

    blob = b""
    for suffix in ("", "-wal", "-shm"):
        candidate = db.with_name(db.name + suffix)
        if candidate.exists():
            blob += candidate.read_bytes()

    for secret in (pairing.code, pairing.code.replace("-", ""), pairing.pairing_id, token):
        assert secret.encode() not in blob


def test_generated_codes_stay_well_formed_across_many_draws(db):
    # 只抽一次查不出「有人把 secrets 换成 random」或字母表被截断这类退化。
    codes = {blender_store.create_pairing(db).code for _ in range(200)}

    assert len(codes) == 200
    for code in codes:
        assert len(code) == 9 and code[4] == "-"
        assert set(code) <= set("ABCDEFGHJKLMNPQRSTUVWXYZ23456789-")


def _issue_token(db, *, user_id="alice", label="Blender"):
    pairing = blender_store.create_pairing(db)
    blender_store.approve_pairing(db, pairing.code, user_id=user_id)
    result = blender_store.consume_pairing(db, pairing.pairing_id)
    return result.token


def test_valid_token_resolves_to_its_owner(db):
    token = _issue_token(db, user_id="alice")

    client = blender_store.verify_token(db, token)

    assert client is not None
    assert client.user_id == "alice"
    assert client.label == "Blender"


def test_garbage_token_resolves_to_nothing(db):
    assert blender_store.verify_token(db, "not-a-token") is None
    assert blender_store.verify_token(db, "") is None


def test_expired_token_resolves_to_nothing(db, monkeypatch):
    token = _issue_token(db)
    later = time.time() + blender_store.TOKEN_TTL_SECONDS + 1
    monkeypatch.setattr(blender_store, "_now", lambda: int(later))

    assert blender_store.verify_token(db, token) is None


def test_revoked_token_resolves_to_nothing(db):
    token = _issue_token(db)
    token_id = blender_store.list_tokens(db, user_id="alice")[0].token_id

    assert blender_store.revoke_token(db, token_id, user_id="alice") is True
    assert blender_store.verify_token(db, token) is None


def test_revoking_someone_elses_token_fails(db):
    _issue_token(db, user_id="alice")
    token_id = blender_store.list_tokens(db, user_id="alice")[0].token_id

    # 吊销要带 user_id 一起做条件：拿到别人的 token_id 也动不了他的插件。
    assert blender_store.revoke_token(db, token_id, user_id="bob") is False


def test_revoking_twice_fails(db):
    _issue_token(db)
    token_id = blender_store.list_tokens(db, user_id="alice")[0].token_id

    assert blender_store.revoke_token(db, token_id, user_id="alice") is True
    assert blender_store.revoke_token(db, token_id, user_id="alice") is False


def test_list_tokens_is_scoped_to_the_user_and_hides_the_secret(db):
    _issue_token(db, user_id="alice")
    _issue_token(db, user_id="bob")

    alice = blender_store.list_tokens(db, user_id="alice")

    assert len(alice) == 1
    assert not hasattr(alice[0], "token")
    assert not hasattr(alice[0], "token_hash")


def test_list_tokens_hides_revoked_ones(db):
    _issue_token(db, user_id="alice")
    token_id = blender_store.list_tokens(db, user_id="alice")[0].token_id
    blender_store.revoke_token(db, token_id, user_id="alice")

    assert blender_store.list_tokens(db, user_id="alice") == []


def test_verify_token_records_last_seen(db, monkeypatch):
    token = _issue_token(db, user_id="alice")
    # 用相对时间，不要写死一个 epoch 常量：写死的那个迟早会越过令牌的 30 天有效期，
    # 到时候 verify_token 把它当过期令牌拒掉，这条测试就在测别的东西了。
    later = int(time.time()) + 60
    monkeypatch.setattr(blender_store, "_now", lambda: later)

    blender_store.verify_token(db, token)

    # 设置页要能回答「这台还在用吗」，否则用户不知道该吊销哪一条。
    assert blender_store.list_tokens(db, user_id="alice")[0].last_seen == later
