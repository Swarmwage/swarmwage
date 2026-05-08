# Sample input for Swarmwage capability `code.execute.sandboxed`.
# Pyodide-WASM compatible: pure Python, no I/O, no network, no filesystem access.
# License: CC0 1.0 Universal (public domain).

from functools import lru_cache


@lru_cache(maxsize=None)
def fib(n: int) -> int:
    if n < 2:
        return n
    return fib(n - 1) + fib(n - 2)


if __name__ == "__main__":
    values = [fib(i) for i in range(20)]
    print("First 20 Fibonacci numbers:")
    print(values)
