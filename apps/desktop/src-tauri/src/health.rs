//! Minimal blocking `GET /health` probe over `std::net::TcpStream`.

use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpStream};
use std::time::{Duration, Instant};

/// True when the raw HTTP response has a 2xx status line.
pub fn is_healthy_response(response: &[u8]) -> bool {
    let line = response.split(|&b| b == b'\n').next().unwrap_or_default();
    let mut parts = std::str::from_utf8(line).unwrap_or_default().split_whitespace();
    let version = parts.next().unwrap_or_default();
    let status = parts.next().unwrap_or_default();
    version.starts_with("HTTP/1.") && status.len() == 3 && status.starts_with('2')
}

/// One probe's outcome. `failure` is a fixed code so diagnostics stay a closed vocabulary.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HealthProbe {
    pub ok: bool,
    pub failure: &'static str,
    pub status: u16,
    pub elapsed_ms: u128,
}

/// The numeric status of a raw HTTP response, or zero when there is no status line.
pub fn status_code(response: &[u8]) -> u16 {
    let line = response.split(|&b| b == b'\n').next().unwrap_or_default();
    std::str::from_utf8(line)
        .unwrap_or_default()
        .split_whitespace()
        .nth(1)
        .and_then(|status| status.parse().ok())
        .unwrap_or(0)
}

/// Asks the daemon on `127.0.0.1:<port>` for `/health` and reports why it failed.
pub fn probe_health(port: u16, timeout: Duration) -> HealthProbe {
    let started = Instant::now();
    let done = |ok: bool, failure: &'static str, status: u16| HealthProbe {
        ok,
        failure,
        status,
        elapsed_ms: started.elapsed().as_millis(),
    };
    let address = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    let Ok(mut stream) = TcpStream::connect_timeout(&address, timeout) else {
        return done(false, "connect", 0);
    };
    let _ = stream.set_read_timeout(Some(timeout));
    let _ = stream.set_write_timeout(Some(timeout));
    let request = format!("GET /health HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
    if stream.write_all(request.as_bytes()).is_err() {
        return done(false, "write", 0);
    }
    // The status line arrives in the first packet; no need to read the body.
    let mut buf = [0u8; 64];
    let mut read = 0;
    while read < buf.len() {
        match stream.read(&mut buf[read..]) {
            Ok(0) | Err(_) => break,
            Ok(n) => read += n,
        }
        if buf[..read].contains(&b'\n') {
            break;
        }
    }
    let status = status_code(&buf[..read]);
    if is_healthy_response(&buf[..read]) {
        done(true, "none", status)
    } else if read == 0 {
        done(false, "read", 0)
    } else if status == 0 {
        done(false, "malformed", 0)
    } else {
        done(false, "status", status)
    }
}

/// Asks the daemon on `127.0.0.1:<port>` for `/health` with a short timeout.
pub fn check_health(port: u16, timeout: Duration) -> bool {
    probe_health(port, timeout).ok
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;
    use std::thread;

    fn serve_once(response: &'static str) -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut buf = [0u8; 1024];
            let n = stream.read(&mut buf).unwrap();
            assert!(String::from_utf8_lossy(&buf[..n]).starts_with("GET /health HTTP/1.1\r\n"));
            stream.write_all(response.as_bytes()).unwrap();
        });
        port
    }

    #[test]
    fn parses_status_lines() {
        assert!(is_healthy_response(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{}"));
        assert!(is_healthy_response(b"HTTP/1.0 204 No Content\r\n\r\n"));
        assert!(!is_healthy_response(b"HTTP/1.1 503 Service Unavailable\r\n\r\n"));
        assert!(!is_healthy_response(b"garbage"));
        assert!(!is_healthy_response(b""));
    }

    #[test]
    fn healthy_daemon_answers() {
        let port = serve_once("HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n{\"ok\":true}");
        assert!(check_health(port, Duration::from_millis(500)));
    }

    #[test]
    fn probe_reports_a_fixed_failure_code() {
        let closed = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        assert_eq!(probe_health(closed, Duration::from_millis(200)).failure, "connect");
        let port = serve_once("HTTP/1.1 500 Internal Server Error\r\n\r\n");
        let probe = probe_health(port, Duration::from_millis(500));
        assert_eq!((probe.ok, probe.failure, probe.status), (false, "status", 500));
        let port = serve_once("HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n{}");
        let probe = probe_health(port, Duration::from_millis(500));
        assert_eq!((probe.ok, probe.failure, probe.status), (true, "none", 200));
    }

    #[test]
    fn error_status_or_closed_port_is_unhealthy() {
        let port = serve_once("HTTP/1.1 500 Internal Server Error\r\n\r\n");
        assert!(!check_health(port, Duration::from_millis(500)));
        let closed = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        assert!(!check_health(closed, Duration::from_millis(200)));
    }
}
