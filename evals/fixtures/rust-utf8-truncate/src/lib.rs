/// Clips text to at most `max_bytes` without splitting a UTF-8 code point.
pub fn clip_utf8(value: &str, max_bytes: usize) -> &str {
    if value.len() <= max_bytes {
        return value;
    }
    // BUG: max_bytes may fall in the middle of a multibyte code point.
    &value[..max_bytes]
}
