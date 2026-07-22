def normalize_segments(parts: list[str]) -> list[str]:
    """Resolve dot segments without allowing traversal above the root."""
    output: list[str] = []
    for part in parts:
        if part in ("", "."):
            continue
        if part == "..":
            # BUG: an empty stack raises IndexError for leading/extra traversal.
            output.pop()
            continue
        output.append(part)
    return output
