from __future__ import annotations

import sqlite3
import threading
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


def _inbox_rows(db_path) -> int:
    conn = sqlite3.connect(db_path)
    try:
        return conn.execute("SELECT COUNT(*) FROM blender_inbox").fetchone()[0]
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


def test_recorded_delivery_comes_back_with_its_metadata(db):
    delivery_id = blender_store.record_delivery(
        db,
        user_id="alice",
        project_id="demo",
        url="/files/freezone/_uploads/blockout_Camera_frame_24_20260918.png",
        kind="image",
        filename="blockout_Camera_frame_24_20260918.png",
        camera="Camera",
        frame=24,
        frame_start=None,
        frame_end=None,
        fps=None,
        width=1280,
        height=720,
    )

    items = blender_store.list_inbox(db, user_id="alice", project_id="demo")

    assert [item["delivery_id"] for item in items] == [delivery_id]
    assert items[0]["kind"] == "image"
    assert items[0]["frame"] == 24
    assert items[0]["width"] == 1280


def test_inbox_is_scoped_to_user_and_project(db):
    common = dict(
        url="/files/x.png",
        kind="image",
        filename="x.png",
        camera="Camera",
        frame=1,
        frame_start=None,
        frame_end=None,
        fps=None,
        width=10,
        height=10,
    )
    blender_store.record_delivery(db, user_id="alice", project_id="demo", **common)
    blender_store.record_delivery(db, user_id="alice", project_id="other", **common)
    blender_store.record_delivery(db, user_id="bob", project_id="demo", **common)

    assert len(blender_store.list_inbox(db, user_id="alice", project_id="demo")) == 1


def test_rate_limit_allows_up_to_the_cap_then_refuses(db, monkeypatch):
    # 钉死时钟：固定窗口是按墙上时间切的，用真实时钟跑的话，这几次调用万一
    # 骑在窗口边界上就会悄悄重置计数，测试变成偶发绿。
    monkeypatch.setattr(blender_store, "_now", lambda: 1_800_000_000)

    for _ in range(5):
        assert blender_store.hit_rate_limit(db, "pair:1.2.3.4", limit=5, window=60) is True

    assert blender_store.hit_rate_limit(db, "pair:1.2.3.4", limit=5, window=60) is False


def test_rate_limit_buckets_are_independent(db, monkeypatch):
    monkeypatch.setattr(blender_store, "_now", lambda: 1_800_000_000)
    for _ in range(5):
        blender_store.hit_rate_limit(db, "pair:1.2.3.4", limit=5, window=60)

    assert blender_store.hit_rate_limit(db, "pair:5.6.7.8", limit=5, window=60) is True


def test_rate_limit_window_rolls_over(db, monkeypatch):
    base = 1_800_000_000
    monkeypatch.setattr(blender_store, "_now", lambda: base)
    for _ in range(5):
        blender_store.hit_rate_limit(db, "pair:1.2.3.4", limit=5, window=60)
    assert blender_store.hit_rate_limit(db, "pair:1.2.3.4", limit=5, window=60) is False

    monkeypatch.setattr(blender_store, "_now", lambda: base + 61)

    assert blender_store.hit_rate_limit(db, "pair:1.2.3.4", limit=5, window=60) is True


def test_take_inbox_removes_the_rows_it_returns(db):
    blender_store.record_delivery(
        db, user_id="alice", project_id="demo", url="/files/a.png",
        kind="image", filename="a.png", camera="Camera", frame=1,
        frame_start=None, frame_end=None, fps=None, width=16, height=9,
    )
    first = blender_store.take_inbox(db, user_id="alice", project_id="demo")
    assert [row["filename"] for row in first] == ["a.png"]
    # 认领是一次性的：第二次必须是空的，否则轮询会重复建节点。
    assert blender_store.take_inbox(db, user_id="alice", project_id="demo") == []


def test_take_inbox_is_scoped_to_one_user_and_one_project(db):
    for user_id, project_id, name in (
        ("alice", "demo", "mine.png"),
        ("bob", "demo", "not-mine.png"),
        ("alice", "other", "other-project.png"),
    ):
        blender_store.record_delivery(
            db, user_id=user_id, project_id=project_id, url=f"/files/{name}",
            kind="image", filename=name, camera="", frame=None,
            frame_start=None, frame_end=None, fps=None, width=None, height=None,
        )
    taken = blender_store.take_inbox(db, user_id="alice", project_id="demo")
    assert [row["filename"] for row in taken] == ["mine.png"]
    # 别人的和别的项目的都必须原封不动。
    assert blender_store.take_inbox(db, user_id="bob", project_id="demo")
    assert blender_store.take_inbox(db, user_id="alice", project_id="other")


def test_take_inbox_drops_rows_past_the_ttl(db, monkeypatch):
    stale = int(time.time()) - blender_store.INBOX_TTL_SECONDS - 1
    # created_at 是 record_delivery 里 `_now()` 取的，把时钟拨回去就能造出陈旧行。
    monkeypatch.setattr(blender_store, "_now", lambda: stale)
    blender_store.record_delivery(
        db, user_id="alice", project_id="demo", url="/files/old.png",
        kind="image", filename="old.png", camera="", frame=None,
        frame_start=None, frame_end=None, fps=None, width=None, height=None,
    )
    monkeypatch.undo()
    assert blender_store.take_inbox(db, user_id="alice", project_id="demo") == []
    # 不只是不返回——必须真删掉，否则这张表只增不减。
    assert _inbox_rows(db) == 0


def test_take_inbox_ttl_boundary_is_inclusive(db, monkeypatch):
    # 上一条测试用的是 `now - TTL - 1`：不管 purge 的判定是 `<=` 还是 `<`，
    # 这个偏移量都会通过，边界本身没被钉死。这里分别造一行「正好到期」
    # 和一行「晚一秒到期」，把 `<=`（对齐配对那边 `expires_at <= now` 的写法）
    # 真正验证住。
    now = int(time.time())

    monkeypatch.setattr(
        blender_store, "_now", lambda: now - blender_store.INBOX_TTL_SECONDS
    )
    blender_store.record_delivery(
        db, user_id="alice", project_id="demo", url="/files/exactly-expired.png",
        kind="image", filename="exactly-expired.png", camera="", frame=None,
        frame_start=None, frame_end=None, fps=None, width=None, height=None,
    )
    monkeypatch.setattr(
        blender_store, "_now", lambda: now - blender_store.INBOX_TTL_SECONDS + 1
    )
    blender_store.record_delivery(
        db, user_id="alice", project_id="demo", url="/files/still-fresh.png",
        kind="image", filename="still-fresh.png", camera="", frame=None,
        frame_start=None, frame_end=None, fps=None, width=None, height=None,
    )
    monkeypatch.setattr(blender_store, "_now", lambda: now)

    taken = blender_store.take_inbox(db, user_id="alice", project_id="demo")
    # 正好卡在 TTL 上的那行被清掉了，晚它一秒的那行还在。
    assert [row["filename"] for row in taken] == ["still-fresh.png"]


def test_take_inbox_returns_multiple_rows_in_delivery_order(db, monkeypatch):
    # HTTP 路由会把这里的列表原样转成一串画布节点，顺序必须是投递顺序。
    # record_delivery 的 created_at 只有整秒精度，同一个测试里连续调三次
    # 大概率落在同一秒，所以要把时钟显式往前拨，让顺序断言不是碰运气。
    base = int(time.time())
    names = ["first.png", "second.png", "third.png"]
    for offset, name in enumerate(names):
        monkeypatch.setattr(blender_store, "_now", lambda offset=offset: base + offset)
        blender_store.record_delivery(
            db, user_id="alice", project_id="demo", url=f"/files/{name}",
            kind="image", filename=name, camera="", frame=None,
            frame_start=None, frame_end=None, fps=None, width=None, height=None,
        )
    monkeypatch.undo()

    taken = blender_store.take_inbox(db, user_id="alice", project_id="demo")
    assert [row["filename"] for row in taken] == names
    assert _inbox_rows(db) == 0


def test_take_inbox_breaks_same_second_ties_by_insertion_order(db, monkeypatch):
    # created_at 只精确到整秒，两条投递落在同一秒时光靠它排不出先后。
    # 这是一条「返回顺序」的回归护栏，**不是**对实现里 `, rowid` 次级键生效的证明：
    # 实测把 `, rowid` 去掉这条测试照样通过，因为 `blender_inbox_project` 索引的键
    # 是 (user_id, project_id, created_at, rowid)，查询走的就是它，sqlite 顺带就按
    # 插入顺序还了回来。次级键的价值在于这个索引将来被改或被删时仍然成立——那份
    # 价值这里测不出来，所以别看它通过就以为 tiebreaker 有测试保护。
    same_second = int(time.time())
    monkeypatch.setattr(blender_store, "_now", lambda: same_second)
    blender_store.record_delivery(
        db, user_id="alice", project_id="demo", url="/files/first.png",
        kind="image", filename="first.png", camera="", frame=None,
        frame_start=None, frame_end=None, fps=None, width=None, height=None,
    )
    blender_store.record_delivery(
        db, user_id="alice", project_id="demo", url="/files/second.png",
        kind="image", filename="second.png", camera="", frame=None,
        frame_start=None, frame_end=None, fps=None, width=None, height=None,
    )

    taken = blender_store.take_inbox(db, user_id="alice", project_id="demo")
    assert [row["filename"] for row in taken] == ["first.png", "second.png"]


def test_concurrent_take_inbox_hands_the_row_to_exactly_one_caller(db):
    """8 线程 × 10 轮不是随便定的数字。

    barrier 只同步「进入 take_inbox」这一刻；之后每个线程还要各自走完
    purge_expired 的整套连接建立（PRAGMA、`executescript(_SCHEMA)`、两条
    DELETE）才会真正碰到共享的那一行，这段准备工作本身就会把线程错开。
    结果是：哪怕把 take_inbox 换成一个完全非原子的实现（纯 SELECT 后 DELETE，
    中间没有事务），2 线程单轮这个测试仍有约 97.5% 的概率误判为通过——
    实测探测率只有约 2.5%。8 线程单轮能把探测率提到约 52%，仍不够稳。
    重复 10 轮、要求每一轮都恰好取出一行，漏检概率降到
    (1 - 0.52) ** 10 ≈ 0.05%，探测率约 99.9%，运行时间仍是秒级。
    """
    for round_index in range(10):
        blender_store.record_delivery(
            db, user_id="alice", project_id="demo", url=f"/files/{round_index}.png",
            kind="image", filename=f"{round_index}.png", camera="", frame=None,
            frame_start=None, frame_end=None, fps=None, width=None, height=None,
        )
        results: list[list[dict]] = []
        barrier = threading.Barrier(8)

        def worker() -> None:
            barrier.wait()
            results.append(
                blender_store.take_inbox(db, user_id="alice", project_id="demo")
            )

        threads = [threading.Thread(target=worker) for _ in range(8)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        # 一轮下来，8 个线程抢的是同一行，总共只能取出一次——否则画布上会
        # 出现重复节点。
        assert sum(len(rows) for rows in results) == 1
