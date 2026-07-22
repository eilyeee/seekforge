package paginationwindow

import (
	"reflect"
	"testing"
)

func TestWindowIncludesExactEnd(t *testing.T) {
	got := Window([]int{10, 20, 30, 40}, 2, 2)
	want := []int{30, 40}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("Window() = %v, want %v", got, want)
	}
}

func TestWindowClampsBeyondEnd(t *testing.T) {
	if got := Window([]int{1, 2}, 8, 3); len(got) != 0 {
		t.Fatalf("Window() = %v, want empty", got)
	}
}
