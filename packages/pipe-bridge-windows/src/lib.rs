//! Native bridge for the Windows app<->daemon private channel. This crate is Windows-only in
//! purpose; the pure identity comparison below has no platform-specific code yet. Real Win32
//! calls (GetNamedPipeServerProcessId, OpenProcess, GetProcessTimes) are added in a later unit,
//! which is also where a `cfg(target_os = "windows")` guard belongs.

use napi_derive::napi;

/// A connected pipe's reported server identity matches an expected one only when both the PID
/// and the exact process creation time agree, so a reused PID cannot be mistaken for the
/// original launching process. `created_at` is the 64-bit FILETIME `GetProcessTimes` reports,
/// combined from its `dwLowDateTime`/`dwHighDateTime` pair.
///
/// napi-rs maps `i64` to a JS `number`, which loses precision above 2^53; a real FILETIME (100 ns
/// ticks since 1601) is already past that today. The next unit (3c.1b) must carry `created_at` as
/// a JS `BigInt` instead, not copy this signature as-is; this scaffold only proves the build path.
#[napi]
pub fn identity_matches(
    expected_pid: u32,
    expected_created_at: i64,
    actual_pid: u32,
    actual_created_at: i64,
) -> bool {
    expected_pid == actual_pid && expected_created_at == actual_created_at
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_only_when_both_pid_and_creation_time_agree() {
        assert!(identity_matches(100, 5_000, 100, 5_000));
        assert!(!identity_matches(100, 5_000, 101, 5_000));
        assert!(!identity_matches(100, 5_000, 100, 5_001));
        assert!(!identity_matches(100, 5_000, 101, 5_001));
    }

    #[test]
    fn compares_boundary_pids_and_full_width_creation_times() {
        assert!(identity_matches(0, 0, 0, 0));
        assert!(identity_matches(u32::MAX, i64::MAX, u32::MAX, i64::MAX));
        assert!(!identity_matches(
            u32::MAX,
            i64::MAX,
            u32::MAX,
            i64::MAX - 1
        ));
        // A realistic FILETIME above 2^53 must still compare correctly on the Rust side; the JS
        // precision loss this guards against on the binding side is tracked for 3c.1b.
        assert!(!identity_matches(
            1,
            133_700_000_000_000_001,
            1,
            133_700_000_000_000_002
        ));
    }
}
