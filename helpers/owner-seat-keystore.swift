// TeamCLI owner-seat key helper (macOS). A P-256 key generated inside the Secure Enclave and kept
// in the Keychain with user-presence access control: every signature asks for Touch ID or the
// login password. Only the public key ever leaves this helper.
//
//   owner-seat-keystore create <label>          prints the public key (X9.63, hex)
//   owner-seat-keystore public <label>          prints the public key of an existing key
//   owner-seat-keystore sign <label> <reason>   reads hex bytes on stdin, prints a DER ECDSA-SHA256 signature (hex)
//   owner-seat-keystore sign-many <label> <reason>
//                                               reads one hex message per line on stdin (at most 32), asks for
//                                               user presence once, prints one signature per line, in order
//
//   owner-seat-keystore selftest [--emit]       creates a throwaway Secure Enclave key (no prompt, never stored),
//                                               reloads it from its handle, signs and verifies; --emit prints
//                                               its public key and the DER signature for an outside check
//
// Build: scripts/build-owner-seat-helper.sh (see docs/owner-seat-setup.md).
//
// Two backends, chosen per key at creation and found again by label:
// - `keychain`: the key is a permanent Keychain item. This needs the data-protection keychain, so a
//   binary signed with a keychain-access-groups / application-identifier entitlement (and, for
//   those restricted entitlements, a provisioning profile in an .app bundle). An ad-hoc swiftc
//   build gets errSecMissingEntitlement (-34018) here.
// - `enclave-blob`: the key is created inside the Secure Enclave through CryptoKit and only its
//   `dataRepresentation` is kept, in keys/<label>.se next to this binary (mode 0600). That blob is
//   wrapped by this Mac's Secure Enclave: it is not the private key, cannot be used on any other
//   machine, and every signature still asks for Touch ID or the login password. It needs no
//   entitlement, so an ad-hoc build works. `create` uses it when the keychain refuses with -34018,
//   or always when OWNER_SEAT_BACKEND=enclave-blob.
import CryptoKit
import Foundation
import LocalAuthentication
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

// MARK: enclave-blob backend

let keysDir = URL(fileURLWithPath: CommandLine.arguments[0]).resolvingSymlinksInPath().deletingLastPathComponent().appendingPathComponent("keys")

func blobURL(_ label: String) -> URL {
  guard label.range(of: "^[A-Za-z0-9._-]{1,128}$", options: .regularExpression) != nil else { fail("bad label") }
  return keysDir.appendingPathComponent(label + ".se")
}

func blobKey(_ label: String, reason: String?) -> SecureEnclave.P256.Signing.PrivateKey? {
  guard let data = try? Data(contentsOf: blobURL(label)) else { return nil }
  let context = LAContext()
  if let reason = reason { context.localizedReason = reason }
  return try? SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: data, authenticationContext: context)
}

func blobCreate(_ label: String) -> String {
  guard SecureEnclave.isAvailable else { fail("no Secure Enclave on this Mac") }
  let url = blobURL(label)
  if FileManager.default.fileExists(atPath: url.path) { fail("a key named \(label) already exists") }
  var acError: Unmanaged<CFError>?
  guard let access = SecAccessControlCreateWithFlags(kCFAllocatorDefault, kSecAttrAccessibleWhenUnlockedThisDeviceOnly, [.privateKeyUsage, .userPresence], &acError) else {
    fail("access control could not be created")
  }
  let key: SecureEnclave.P256.Signing.PrivateKey
  do { key = try SecureEnclave.P256.Signing.PrivateKey(accessControl: access) } catch { fail("the Secure Enclave refused to create the key: \(error)") }
  do {
    try FileManager.default.createDirectory(at: keysDir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    guard FileManager.default.createFile(atPath: url.path, contents: key.dataRepresentation, attributes: [.posixPermissions: 0o600]) else { fail("the key handle could not be written") }
  } catch { fail("the key handle could not be written: \(error)") }
  return hex(key.publicKey.x963Representation)
}

let errSecMissingEntitlementCode: OSStatus = -34018

let args = CommandLine.arguments
if args.count >= 2 && args[1] == "selftest" {
  // A throwaway key with no access control (so no prompt), never written anywhere. It goes through
  // the same path a stored key does: created in the enclave, reloaded from its dataRepresentation,
  // then signing. `selftest --emit` also prints the public key and the DER signature over the
  // fixed message, so a caller can check that TeamCLI's verifier accepts this helper's format.
  guard SecureEnclave.isAvailable else { fail("selftest: no Secure Enclave on this Mac") }
  let message = Data("teamcli owner-seat selftest".utf8)
  do {
    let created = try SecureEnclave.P256.Signing.PrivateKey()
    let key = try SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: created.dataRepresentation)
    guard key.publicKey.x963Representation == created.publicKey.x963Representation else { fail("selftest: the reloaded key differs") }
    let signature = try key.signature(for: message)
    guard created.publicKey.isValidSignature(signature, for: message) else { fail("selftest: signature did not verify") }
    if args.count == 3 && args[2] == "--emit" {
      print(hex(key.publicKey.x963Representation))
      print(hex(signature.derRepresentation))
    }
  } catch { fail("selftest: Secure Enclave signing failed: \(error)") }
  print("ok secure-enclave")
  exit(0)
}
guard args.count >= 3 else { fail("usage: owner-seat-keystore create|public|sign|sign-many|pin-set|pin-get <label> [reason] | selftest") }
let command = args[1]
let label = args[2]

switch command {
case "create":
  if findKey(label, reason: nil) != nil || blobKey(label, reason: nil) != nil || FileManager.default.fileExists(atPath: blobURL(label).path) { fail("a key named \(label) already exists") }
  if ProcessInfo.processInfo.environment["OWNER_SEAT_BACKEND"] == "enclave-blob" { print(blobCreate(label)); exit(0) }
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
    let cfError = error!.takeRetainedValue()
    if CFErrorGetCode(cfError) == Int(errSecMissingEntitlementCode) { print(blobCreate(label)); exit(0) }
    fail("the key could not be created: \(cfError)")
  }
  print(publicHex(key))
case "public":
  if let key = findKey(label, reason: nil) { print(publicHex(key)) }
  else if let key = blobKey(label, reason: nil) { print(hex(key.publicKey.x963Representation)) }
  else { fail("no key named \(label)") }
case "sign":
  let reason = args.count >= 4 ? args[3] : "TeamCLI owner seat signature"
  guard let message = unhex(String(data: FileHandle.standardInput.readDataToEndOfFile(), encoding: .utf8) ?? "") else { fail("stdin is not hex") }
  if findKey(label, reason: nil) == nil {
    guard let key = blobKey(label, reason: reason) else { fail("no key named \(label)") }
    guard let signature = try? key.signature(for: message) else { fail("signing was refused or failed") }
    print(hex(signature.derRepresentation))
    exit(0)
  }
  guard let key = findKey(label, reason: reason) else { fail("no key named \(label)") }
  var error: Unmanaged<CFError>?
  guard let signature = SecKeyCreateSignature(key, .ecdsaSignatureMessageX962SHA256, message as CFData, &error) as Data? else {
    fail("signing was refused or failed")
  }
  print(hex(signature))
case "sign-many":
  // Several answers under one user-presence prompt. The prompt names them all (the caller writes
  // one card listing every answer into `reason`). The context is evaluated once, then every
  // signature is made with that same context, so the key's user-presence check is the one the
  // owner just passed and no second prompt is shown. Each message is signed on its own: nothing
  // here combines them, and each signature verifies as one made by `sign`.
  let reason = args.count >= 4 ? args[3] : "TeamCLI owner seat signatures"
  let lines = (String(data: FileHandle.standardInput.readDataToEndOfFile(), encoding: .utf8) ?? "")
    .split(whereSeparator: { $0.isNewline }).map(String.init).filter { !$0.isEmpty }
  guard !lines.isEmpty, lines.count <= 32 else { fail("stdin holds no message, or more than 32") }
  var messages: [Data] = []
  for line in lines {
    guard let message = unhex(line) else { fail("stdin is not one hex message per line") }
    messages.append(message)
  }
  let useKeychain = findKey(label, reason: nil) != nil
  if !useKeychain && !FileManager.default.fileExists(atPath: blobURL(label).path) { fail("no key named \(label)") }
  final class Outcome: @unchecked Sendable { var passed = false }
  let outcome = Outcome()
  let context = LAContext()
  context.localizedReason = reason
  let done = DispatchSemaphore(value: 0)
  context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) { passed, _ in
    outcome.passed = passed
    done.signal()
  }
  done.wait()
  guard outcome.passed else { fail("signing was refused or failed") }
  var signatures: [String] = []
  if useKeychain {
    let query: [String: Any] = [
      kSecClass as String: kSecClassKey,
      kSecAttrApplicationTag as String: tag(label),
      kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
      kSecReturnRef as String: true,
      kSecUseAuthenticationContext as String: context,
    ]
    var item: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess, let found = item else { fail("no key named \(label)") }
    let key = found as! SecKey
    for message in messages {
      var error: Unmanaged<CFError>?
      guard let signature = SecKeyCreateSignature(key, .ecdsaSignatureMessageX962SHA256, message as CFData, &error) as Data? else {
        fail("signing was refused or failed")
      }
      signatures.append(hex(signature))
    }
  } else {
    guard let data = try? Data(contentsOf: blobURL(label)),
          let key = try? SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: data, authenticationContext: context) else {
      fail("no key named \(label)")
    }
    for message in messages {
      guard let signature = try? key.signature(for: message) else { fail("signing was refused or failed") }
      signatures.append(hex(signature.derRepresentation))
    }
  }
  print(signatures.joined(separator: "\n"))
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
