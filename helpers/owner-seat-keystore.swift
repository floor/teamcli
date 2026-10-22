// TeamCLI owner-seat key helper (macOS). A P-256 key generated inside the Secure Enclave and kept
// in the Keychain with user-presence access control: every signature asks for Touch ID or the
// login password. Only the public key ever leaves this helper.
//
//   owner-seat-keystore create <label>          prints the public key (X9.63, hex)
//   owner-seat-keystore public <label>          prints the public key of an existing key
//   owner-seat-keystore sign <label> <reason>   reads hex bytes on stdin, prints a DER ECDSA-SHA256 signature (hex)
//
// Build: swiftc helpers/owner-seat-keystore.swift -o ~/.config/team-owner-seat/owner-seat-keystore
// A Secure Enclave key that persists in the Keychain may need a code-signed binary with a
// keychain-access-groups entitlement; an unsigned build can fail with errSecMissingEntitlement.
import Foundation
import Security

func fail(_ message: String) -> Never {
  FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
  exit(1)
}

func hex(_ data: Data) -> String { data.map { String(format: "%02x", $0) }.joined() }

func unhex(_ text: String) -> Data? {
  let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
  guard t.count % 2 == 0 else { return nil }
  var data = Data()
  var i = t.startIndex
  while i < t.endIndex {
    let j = t.index(i, offsetBy: 2)
    guard let b = UInt8(t[i..<j], radix: 16) else { return nil }
    data.append(b)
    i = j
  }
  return data
}

func tag(_ label: String) -> Data { ("com.teamcli.owner-seat." + label).data(using: .utf8)! }

func findKey(_ label: String, reason: String?) -> SecKey? {
  var query: [String: Any] = [
    kSecClass as String: kSecClassKey,
    kSecAttrApplicationTag as String: tag(label),
    kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
    kSecReturnRef as String: true,
  ]
  if let reason = reason { query[kSecUseOperationPrompt as String] = reason }
  var item: CFTypeRef?
  guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess, let found = item else { return nil }
  return (found as! SecKey)
}

func publicHex(_ key: SecKey) -> String {
  guard let pub = SecKeyCopyPublicKey(key) else { fail("no public key") }
  var error: Unmanaged<CFError>?
  guard let data = SecKeyCopyExternalRepresentation(pub, &error) as Data? else { fail("public key export failed") }
  return hex(data)
}

let args = CommandLine.arguments
guard args.count >= 3 else { fail("usage: owner-seat-keystore create|public|sign|pin-set|pin-get <label> [reason]") }
let command = args[1]
let label = args[2]

switch command {
case "create":
  if findKey(label, reason: nil) != nil { fail("a key named \(label) already exists") }
  var acError: Unmanaged<CFError>?
  guard let access = SecAccessControlCreateWithFlags(kCFAllocatorDefault, kSecAttrAccessibleWhenUnlockedThisDeviceOnly, [.privateKeyUsage, .userPresence], &acError) else {
    fail("access control could not be created")
  }
  let attributes: [String: Any] = [
    kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
    kSecAttrKeySizeInBits as String: 256,
    kSecAttrTokenID as String: kSecAttrTokenIDSecureEnclave,
    kSecPrivateKeyAttrs as String: [
      kSecAttrIsPermanent as String: true,
      kSecAttrApplicationTag as String: tag(label),
      kSecAttrAccessControl as String: access,
    ] as [String: Any],
  ]
  var error: Unmanaged<CFError>?
  guard let key = SecKeyCreateRandomKey(attributes as CFDictionary, &error) else {
    fail("the key could not be created: \(error!.takeRetainedValue())")
  }
  print(publicHex(key))
case "public":
  guard let key = findKey(label, reason: nil) else { fail("no key named \(label)") }
  print(publicHex(key))
case "sign":
  let reason = args.count >= 4 ? args[3] : "TeamCLI owner seat signature"
  guard let message = unhex(String(data: FileHandle.standardInput.readDataToEndOfFile(), encoding: .utf8) ?? "") else { fail("stdin is not hex") }
  guard let key = findKey(label, reason: reason) else { fail("no key named \(label)") }
  var error: Unmanaged<CFError>?
  guard let signature = SecKeyCreateSignature(key, .ecdsaSignatureMessageX962SHA256, message as CFData, &error) as Data? else {
    fail("signing was refused or failed")
  }
  print(hex(signature))
case "pin-set":
  // A pinned public key for a non-keychain signer (a passkey), stored once and never overwritten.
  let value = (String(data: FileHandle.standardInput.readDataToEndOfFile(), encoding: .utf8) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
  guard !value.isEmpty else { fail("stdin is empty") }
  let item: [String: Any] = [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: "com.teamcli.owner-seat.pin",
    kSecAttrAccount as String: label,
    kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
    kSecValueData as String: value.data(using: .utf8)!,
  ]
  let status = SecItemAdd(item as CFDictionary, nil)
  guard status == errSecSuccess else { fail("the pin could not be stored (status \(status))") }
  print("ok")
case "pin-get":
  let query: [String: Any] = [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: "com.teamcli.owner-seat.pin",
    kSecAttrAccount as String: label,
    kSecReturnData as String: true,
    kSecMatchLimit as String: kSecMatchLimitOne,
  ]
  var out: CFTypeRef?
  guard SecItemCopyMatching(query as CFDictionary, &out) == errSecSuccess, let data = out as? Data, let value = String(data: data, encoding: .utf8) else { fail("no pin named \(label)") }
  print(value)
default:
  fail("unknown command \(command)")
}
