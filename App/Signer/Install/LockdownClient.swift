import Foundation
import Security
import SignKit

/// Talking to the service inside iOS that the Finder talks to (lockdownd), and through it to
/// the file service and the installer. Tenth on docs/FEATURES.md - how SideStore installs.
///
/// Plain sockets rather than the newer networking stack, because this protocol starts in the
/// clear and then turns the *same* connection into a secure one half way through, which the
/// newer stack cannot do. The secure part proves who we are with the certificate out of the
/// pairing file; the phone's own certificate is signed by itself, so it is accepted on purpose
/// after being checked against the one in the pairing file.
final class LockdownClient {
    private var handle: Int32 = -1
    private var ssl: SSLContext?
    private var incoming = Data()

    enum Failure: LocalizedError {
        case connect(String)
        case closed
        case refused(String)
        case tls(OSStatus)
        case identity(String)

        var errorDescription: String? {
            switch self {
            case .connect(let where_): return "Could not reach iOS's install service at \(where_)."
            case .closed: return "iOS closed the connection part-way through."
            case .refused(let reason): return "iOS refused: \(reason)."
            case .tls(let status): return "The secure handshake with iOS failed (\(status))."
            case .identity(let reason): return "The pairing file could not be used: \(reason)."
            }
        }
    }

    // MARK: - the socket

    func connect(host: String, port: UInt16, timeoutSeconds: Int = 10) throws {
        close()
        var hints = addrinfo(ai_flags: 0, ai_family: AF_UNSPEC, ai_socktype: SOCK_STREAM,
                             ai_protocol: 0, ai_addrlen: 0, ai_canonname: nil,
                             ai_addr: nil, ai_next: nil)
        var list: UnsafeMutablePointer<addrinfo>?
        guard getaddrinfo(host, String(port), &hints, &list) == 0, let found = list else {
            throw Failure.connect("\(host):\(port)")
        }
        defer { freeaddrinfo(list) }
        var candidate = found
        while true {
            let socketHandle = socket(candidate.pointee.ai_family, candidate.pointee.ai_socktype,
                                      candidate.pointee.ai_protocol)
            if socketHandle >= 0 {
                var timeout = timeval(tv_sec: timeoutSeconds, tv_usec: 0)
                setsockopt(socketHandle, SOL_SOCKET, SO_RCVTIMEO, &timeout,
                           socklen_t(MemoryLayout<timeval>.size))
                setsockopt(socketHandle, SOL_SOCKET, SO_SNDTIMEO, &timeout,
                           socklen_t(MemoryLayout<timeval>.size))
                if Darwin.connect(socketHandle, candidate.pointee.ai_addr,
                                  candidate.pointee.ai_addrlen) == 0 {
                    handle = socketHandle
                    return
                }
                Darwin.close(socketHandle)
            }
            guard let next = candidate.pointee.ai_next else { break }
            candidate = next
        }
        throw Failure.connect("\(host):\(port)")
    }

    func close() {
        if let ssl {
            SSLClose(ssl)
            self.ssl = nil
        }
        if handle >= 0 {
            Darwin.close(handle)
            handle = -1
        }
        incoming = Data()
    }

    private func writeRaw(_ data: Data) throws {
        var sent = 0
        let bytes = [UInt8](data)
        while sent < bytes.count {
            let written = bytes.withUnsafeBufferPointer { pointer in
                Darwin.send(handle, pointer.baseAddress! + sent, bytes.count - sent, 0)
            }
            guard written > 0 else { throw Failure.closed }
            sent += written
        }
    }

    private func readRaw(upTo count: Int) throws -> Data {
        var buffer = [UInt8](repeating: 0, count: count)
        let read = buffer.withUnsafeMutableBufferPointer { pointer in
            recv(handle, pointer.baseAddress, count, 0)
        }
        guard read > 0 else { throw Failure.closed }
        return Data(buffer[0..<read])
    }

    // MARK: - the same connection, now secure

    /// SecureTransport reads and writes through these two, so the handshake runs over the
    /// socket we already have.
    private static let readCallback: SSLReadFunc = { connection, data, dataLength in
        let client = Unmanaged<LockdownClient>.fromOpaque(connection).takeUnretainedValue()
        var wanted = dataLength.pointee
        var filled = 0
        while filled < wanted {
            let got = recv(client.handle, data.advanced(by: filled), wanted - filled, 0)
            if got > 0 {
                filled += got
            } else if got == 0 {
                dataLength.pointee = filled
                return errSSLClosedGraceful
            } else {
                dataLength.pointee = filled
                return errSSLWouldBlock
            }
        }
        dataLength.pointee = filled
        wanted = filled
        return noErr
    }

    private static let writeCallback: SSLWriteFunc = { connection, data, dataLength in
        let client = Unmanaged<LockdownClient>.fromOpaque(connection).takeUnretainedValue()
        let wanted = dataLength.pointee
        var sent = 0
        while sent < wanted {
            let written = Darwin.send(client.handle, data.advanced(by: sent), wanted - sent, 0)
            if written > 0 {
                sent += written
            } else {
                dataLength.pointee = sent
                return errSSLWouldBlock
            }
        }
        dataLength.pointee = sent
        return noErr
    }

    /// What SecureTransport says when it has looked at the other side's certificate and is
    /// waiting to be told whether to go on. Swift does not carry the name, only the number.
    static let serverAuthCompleted: OSStatus = -9841

    func startTLS(identity: SecIdentity) throws {
        guard let context = SSLCreateContext(nil, .clientSide, .streamType) else {
            throw Failure.tls(-1)
        }
        ssl = context
        var status = SSLSetIOFuncs(context, LockdownClient.readCallback, LockdownClient.writeCallback)
        guard status == noErr else { throw Failure.tls(status) }
        status = SSLSetConnection(context, Unmanaged.passUnretained(self).toOpaque())
        guard status == noErr else { throw Failure.tls(status) }
        // The phone signs its own certificate, so judging it by the usual rules would always
        // fail. Holding the pairing file is what proves this is our phone.
        status = SSLSetSessionOption(context, .breakOnServerAuth, true)
        guard status == noErr else { throw Failure.tls(status) }
        status = SSLSetCertificate(context, [identity] as CFArray)
        guard status == noErr else { throw Failure.tls(status) }

        while true {
            let result = SSLHandshake(context)
            switch result {
            case noErr:
                return
            case errSSLWouldBlock:
                continue
            case LockdownClient.serverAuthCompleted:
                continue   // we are not judging the phone's certificate; carry on
            default:
                throw Failure.tls(result)
            }
        }
    }

    // MARK: - messages

    private func send(_ data: Data) throws {
        guard let ssl else {
            try writeRaw(data)
            return
        }
        var sent = 0
        let bytes = [UInt8](data)
        while sent < bytes.count {
            var written = 0
            let status = bytes.withUnsafeBufferPointer { pointer in
                SSLWrite(ssl, pointer.baseAddress! + sent, bytes.count - sent, &written)
            }
            if status == noErr || status == errSSLWouldBlock {
                sent += written
                if written == 0 && status == errSSLWouldBlock { continue }
            } else {
                throw Failure.tls(status)
            }
        }
    }

    private func readSome() throws -> Data {
        guard let ssl else { return try readRaw(upTo: 64 * 1024) }
        var buffer = [UInt8](repeating: 0, count: 64 * 1024)
        var read = 0
        let status = buffer.withUnsafeMutableBufferPointer { pointer in
            SSLRead(ssl, pointer.baseAddress!, pointer.count, &read)
        }
        if read > 0 { return Data(buffer[0..<read]) }
        if status == errSSLWouldBlock { return Data() }
        throw status == errSSLClosedGraceful ? Failure.closed : Failure.tls(status)
    }

    /// Sends one message and waits for the answer.
    func ask(_ plist: [String: Any]) throws -> [String: Any] {
        try send(try LockdownWire.frame(plist))
        while true {
            if let answer = try LockdownWire.unframe(&incoming) { return answer }
            let more = try readSome()
            guard !more.isEmpty else { continue }
            incoming.append(more)
        }
    }

    /// Waits for the next message without sending one. The installer sends several as it goes.
    func next() throws -> [String: Any] {
        while true {
            if let answer = try LockdownWire.unframe(&incoming) { return answer }
            let more = try readSome()
            guard !more.isEmpty else { continue }
            incoming.append(more)
        }
    }

    /// Sends a message without waiting for an answer.
    func tell(_ plist: [String: Any]) throws {
        try send(try LockdownWire.frame(plist))
    }

    /// Sends raw bytes (the file service has its own packets).
    func sendRaw(_ data: Data) throws { try send(data) }

    /// Waits for one answer from the file service.
    func afcAnswer() throws -> AFC.Answer {
        while true {
            if let answer = try AFC.answer(from: &incoming) { return answer }
            let more = try readSome()
            guard !more.isEmpty else { continue }
            incoming.append(more)
        }
    }

    /// Anything already read but not used yet, handed over when a service changes port.
    func takeLeftovers() -> Data {
        let left = incoming
        incoming = Data()
        return left
    }

    deinit { close() }
}

/// Turning the certificate and key out of a pairing file into something iOS will use as a
/// client certificate. iOS only builds one of those out of its own keychain, so both halves go
/// in, the pair is fetched back, and both are taken out again afterwards.
enum PairingIdentity {
    static func make(from pairing: PairingFile) throws -> (identity: SecIdentity, cleanup: () -> Void) {
        guard let certificateDER = pairing.hostCertificateDER,
              let keyDER = pairing.hostPrivateKeyDER else {
            throw LockdownClient.Failure.identity("the certificate or key is missing")
        }
        guard let certificate = SecCertificateCreateWithData(nil, certificateDER as CFData) else {
            throw LockdownClient.Failure.identity("the certificate could not be read")
        }
        let tag = "signer.pairing.\(UUID().uuidString)"
        let attributes: [CFString: Any] = [
            kSecAttrKeyType: kSecAttrKeyTypeRSA,
            kSecAttrKeyClass: kSecAttrKeyClassPrivate,
        ]
        var error: Unmanaged<CFError>?
        guard let key = SecKeyCreateWithData(keyDER as CFData, attributes as CFDictionary, &error) else {
            throw LockdownClient.Failure.identity("the private key could not be read")
        }

        let keyQuery: [CFString: Any] = [
            kSecClass: kSecClassKey,
            kSecValueRef: key,
            kSecAttrApplicationTag: Data(tag.utf8),
            kSecAttrLabel: tag,
        ]
        let certificateQuery: [CFString: Any] = [
            kSecClass: kSecClassCertificate,
            kSecValueRef: certificate,
            kSecAttrLabel: tag,
        ]
        SecItemAdd(keyQuery as CFDictionary, nil)
        SecItemAdd(certificateQuery as CFDictionary, nil)

        let cleanup: () -> Void = {
            SecItemDelete([kSecClass: kSecClassKey, kSecAttrApplicationTag: Data(tag.utf8)] as CFDictionary)
            SecItemDelete([kSecClass: kSecClassCertificate, kSecAttrLabel: tag] as CFDictionary)
        }

        var found: CFTypeRef?
        let status = SecItemCopyMatching([
            kSecClass: kSecClassIdentity,
            kSecAttrLabel: tag,
            kSecReturnRef: true,
        ] as CFDictionary, &found)
        guard status == errSecSuccess, let identity = found as! SecIdentity? else {
            cleanup()
            throw LockdownClient.Failure.identity("iOS would not pair the certificate with its key")
        }
        return (identity, cleanup)
    }
}
