"""Canonical successful API response with legacy data-container compatibility."""

from __future__ import annotations

from collections.abc import Container, Iterable, Iterator, Mapping, Sized
from typing import Any, Generic, TypeVar, cast

T = TypeVar("T")


class ApiResponse(Generic[T]):
    """Successful Anlyon response.

    ``success``, ``data``, ``pagination``, and ``stats`` mirror the TypeScript
    SDK and HTTP envelope. Indexing, iteration, ``get()``, and equality still
    delegate to ``data`` so pre-0.2 Python code keeps working during migration.
    """

    def __init__(
        self,
        *,
        success: bool,
        data: T,
        pagination: Any = None,
        stats: Any = None,
        request_id: str | None = None,
    ) -> None:
        self.success = success
        self.data = data
        self.pagination = pagination
        self.stats = stats
        self.request_id = request_id

    def __getitem__(self, key: Any) -> Any:
        return self.data[key]  # type: ignore[index]

    def __iter__(self) -> Iterator[Any]:
        return iter(cast(Iterable[Any], self.data))

    def __len__(self) -> int:
        return len(cast(Sized, self.data))

    def __contains__(self, item: object) -> bool:
        return item in cast(Container[object], self.data)

    def get(self, key: Any, default: Any = None) -> Any:
        if isinstance(self.data, Mapping):
            return self.data.get(key, default)
        return default

    def keys(self) -> Any:
        if not isinstance(self.data, Mapping):
            raise TypeError("ApiResponse.data is not a mapping")
        return self.data.keys()

    def values(self) -> Any:
        if not isinstance(self.data, Mapping):
            raise TypeError("ApiResponse.data is not a mapping")
        return self.data.values()

    def items(self) -> Any:
        if not isinstance(self.data, Mapping):
            raise TypeError("ApiResponse.data is not a mapping")
        return self.data.items()

    def __eq__(self, other: object) -> bool:
        if isinstance(other, ApiResponse):
            return (self.success, self.data, self.pagination, self.stats) == (
                other.success,
                other.data,
                other.pagination,
                other.stats,
            )
        return self.data == other

    def __repr__(self) -> str:
        return (
            f"ApiResponse(success={self.success!r}, data={self.data!r}, "
            f"pagination={self.pagination!r}, stats={self.stats!r}, "
            f"request_id={self.request_id!r})"
        )
