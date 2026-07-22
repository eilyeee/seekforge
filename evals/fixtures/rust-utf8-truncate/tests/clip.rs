use rust_utf8_truncate_fixture::clip_utf8;

#[test]
fn clips_at_a_valid_boundary() {
    assert_eq!(clip_utf8("ab修复", 5), "ab修");
    assert_eq!(clip_utf8("ab修复", 4), "ab");
}

#[test]
fn preserves_short_input() {
    assert_eq!(clip_utf8("ok", 8), "ok");
}
