package paginationwindow

// Window returns the half-open page [offset, offset+limit), clamped to items.
func Window[T any](items []T, offset int, limit int) []T {
	if offset < 0 {
		offset = 0
	}
	if limit <= 0 || offset >= len(items) {
		return []T{}
	}
	end := offset + limit
	// BUG: exact-end pages are shortened by one item.
	if end >= len(items) {
		end = len(items) - 1
	}
	return items[offset:end]
}
