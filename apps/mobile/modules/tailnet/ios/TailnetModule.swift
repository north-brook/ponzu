import Darwin
import ExpoModulesCore

/// The phone's network interfaces and their addresses, from getifaddrs. iOS
/// doesn't tell an app whether a VPN is up, but Tailscale's tunnel is an
/// interface like any other, with the device's tailnet address on it;
/// lib/tailnet.ts decides which addresses are Tailscale's.
public final class TailnetModule: Module {
  public func definition() -> ModuleDefinition {
    Name("Tailnet")

    /// Every address on an interface that's up, as `{ name, address }`.
    Function("interfaces") { () -> [[String: String]] in
      Self.interfaces()
    }
  }

  private static func interfaces() -> [[String: String]] {
    var head: UnsafeMutablePointer<ifaddrs>?
    guard getifaddrs(&head) == 0, let first = head else { return [] }
    defer { freeifaddrs(head) }
    var found: [[String: String]] = []
    for pointer in sequence(first: first, next: { $0.pointee.ifa_next }) {
      let ifa = pointer.pointee
      guard let addr = ifa.ifa_addr, (ifa.ifa_flags & UInt32(IFF_UP)) != 0 else { continue }
      let family = Int32(addr.pointee.sa_family)
      guard family == AF_INET || family == AF_INET6 else { continue }
      let length = socklen_t(
        family == AF_INET ? MemoryLayout<sockaddr_in>.size : MemoryLayout<sockaddr_in6>.size)
      var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
      guard
        getnameinfo(addr, length, &host, socklen_t(host.count), nil, 0, NI_NUMERICHOST) == 0
      else { continue }
      found.append(["name": String(cString: ifa.ifa_name), "address": String(cString: host)])
    }
    return found
  }
}
