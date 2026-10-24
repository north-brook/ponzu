import ExpoModulesCore
import Network

/// Browses the local network for a Bonjour service type with Network.framework.
/// Each change sends the whole list, with each service's TXT record, so the
/// JavaScript side never has to reconcile adds and removes. The first browse
/// raises iOS's local network prompt; a refusal shows as the "denied" state.
public final class BonjourModule: Module {
  private var browser: NWBrowser?

  public func definition() -> ModuleDefinition {
    Name("Bonjour")

    Events("onServices", "onState")

    /// Starts browsing `type` (such as `_ponzu._tcp`), replacing any browse already running.
    Function("start") { (type: String) in
      self.stop()
      let browser = NWBrowser(
        for: .bonjourWithTXTRecord(type: type, domain: nil), using: .tcp)
      browser.stateUpdateHandler = { [weak self] state in
        self?.sendEvent("onState", Self.describe(state))
      }
      browser.browseResultsChangedHandler = { [weak self] results, _ in
        self?.sendEvent("onServices", ["services": results.compactMap(Self.describe)])
      }
      browser.start(queue: .main)
      self.browser = browser
    }

    Function("stop") {
      self.stop()
    }

    OnDestroy {
      self.stop()
    }
  }

  private func stop() {
    browser?.cancel()
    browser = nil
  }

  private static func describe(_ result: NWBrowser.Result) -> [String: Any]? {
    guard case let .service(name, type, domain, _) = result.endpoint else { return nil }
    var txt: [String: String] = [:]
    if case let .bonjour(record) = result.metadata {
      txt = record.dictionary
    }
    return ["name": name, "type": type, "domain": domain, "txt": txt]
  }

  private static func describe(_ state: NWBrowser.State) -> [String: Any] {
    switch state {
    case .ready:
      return ["state": "ready"]
    case let .waiting(error), let .failed(error):
      // Local network access refused, in Settings or at the prompt.
      if case let .dns(code) = error, code == kDNSServiceErr_PolicyDenied {
        return ["state": "denied"]
      }
      return ["state": "failed", "error": error.localizedDescription]
    case .cancelled:
      return ["state": "stopped"]
    default:
      return ["state": "starting"]
    }
  }
}
