import Foundation

/// The shapes of the messages iOS's own install services expect, with nothing about networking
/// in them, so they can be checked without a phone.
///
/// Two protocols are involved. **lockdownd** (the service the Finder talks to) swaps property
/// lists, each one with its length in front. **AFC** (the file service) uses its own small
/// packets. On top of those, **installation_proxy** is plain lockdown messages again.
public enum LockdownWire {
    /// A property list with its length in front, which is one lockdown message.
    public static func frame(_ plist: [String: Any]) throws -> Data {
        let body = try PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0)
        var out = Data()
        out.append(UInt8(truncatingIfNeeded: body.count >> 24))
        out.append(UInt8(truncatingIfNeeded: body.count >> 16))
        out.append(UInt8(truncatingIfNeeded: body.count >> 8))
        out.append(UInt8(truncatingIfNeeded: body.count))
        out.append(body)
        return out
    }

    /// Takes one message off the front of whatever has arrived so far. Returns nil while the
    /// message is still on its way.
    public static func unframe(_ buffer: inout Data) throws -> [String: Any]? {
        guard buffer.count >= 4 else { return nil }
        let length = Int(buffer.u32be(0))
        guard length > 0, length < 64 << 20 else {
            throw SignKitError.malformed("the phone sent a message of a silly size")
        }
        guard buffer.count >= 4 + length else { return nil }
        let body = buffer.sub(4, length)
        buffer = buffer.count > 4 + length
            ? buffer.sub(4 + length, buffer.count - 4 - length)
            : Data()
        guard let plist = try? PropertyListSerialization.propertyList(from: body, format: nil),
              let dict = plist as? [String: Any] else {
            throw SignKitError.malformed("the phone sent something that is not a message")
        }
        return dict
    }

    // MARK: - the messages we send

    public static func queryType() -> [String: Any] {
        ["Request": "QueryType", "Label": label]
    }

    public static func startSession(hostID: String, systemBUID: String) -> [String: Any] {
        ["Request": "StartSession", "Label": label, "HostID": hostID, "SystemBUID": systemBUID]
    }

    public static func startService(_ name: String) -> [String: Any] {
        ["Request": "StartService", "Label": label, "Service": name]
    }

    /// installation_proxy: put this app on the phone. The path is where the `.ipa` was put with
    /// AFC, inside the phone's own staging folder.
    public static func install(packagePath: String, bundleID: String?) -> [String: Any] {
        var options: [String: Any] = ["PackageType": "Developer"]
        if let bundleID { options["CFBundleIdentifier"] = bundleID }
        return ["Command": "Install", "PackagePath": packagePath, "ClientOptions": options]
    }

    public static let label = "Signer"

    /// What a StartSession answer says about whether everything after it must be wrapped in TLS.
    public static func needsTLS(_ answer: [String: Any]) -> Bool {
        if let flag = answer["EnableSessionSSL"] as? Bool { return flag }
        if let number = answer["EnableSessionSSL"] as? NSNumber { return number.boolValue }
        return false
    }

    public static func error(in answer: [String: Any]) -> String? {
        if let error = answer["Error"] as? String { return error }
        if let error = answer["ErrorKey"] as? String { return error }
        return nil
    }
}

/// AFC: the service that holds the phone's own file area. Its packets are little-endian and
/// start with a magic that has been the same since 2007.
public enum AFC {
    public static let magic = Data("CFA6LPAA".utf8)

    public enum Operation: UInt64 {
        case status = 1
        case data = 2
        case readDirectory = 3
        case removePath = 8
        case makeDirectory = 9
        case fileOpen = 13
        case fileClose = 20
        case fileWrite = 16
    }

    /// One packet: the magic, how long everything is, how long this header-and-arguments part
    /// is, which message number it is, and what is being asked for.
    public static func packet(operation: UInt64, packetNumber: UInt64,
                              header: Data, payload: Data) -> Data {
        var out = Data()
        out.append(magic)
        let headerLength = 40 + header.count
        let total = headerLength + payload.count
        out.append(le64(UInt64(total)))          // entire length
        out.append(le64(UInt64(headerLength)))   // this length
        out.append(le64(packetNumber))
        out.append(le64(operation))
        out.append(header)
        out.append(payload)
        return out
    }

    /// Opening a file to write: the mode, then the path with a zero after it.
    public static func openForWriting(path: String, packetNumber: UInt64) -> Data {
        var header = le64(3)   // write, make it if it is not there
        header.append(Data(path.utf8))
        header.append(0)
        return packet(operation: Operation.fileOpen.rawValue, packetNumber: packetNumber,
                      header: header, payload: Data())
    }

    public static func write(handle: UInt64, bytes: Data, packetNumber: UInt64) -> Data {
        packet(operation: Operation.fileWrite.rawValue, packetNumber: packetNumber,
               header: le64(handle), payload: bytes)
    }

    public static func close(handle: UInt64, packetNumber: UInt64) -> Data {
        packet(operation: Operation.fileClose.rawValue, packetNumber: packetNumber,
               header: le64(handle), payload: Data())
    }

    public static func makeDirectory(path: String, packetNumber: UInt64) -> Data {
        var header = Data(path.utf8)
        header.append(0)
        return packet(operation: Operation.makeDirectory.rawValue, packetNumber: packetNumber,
                      header: header, payload: Data())
    }

    /// What came back: the operation, and whatever followed the header.
    public struct Answer: Sendable {
        public var operation: UInt64
        public var packetNumber: UInt64
        public var body: Data
        /// For a status answer, 0 means it worked.
        public var status: UInt64? {
            operation == Operation.status.rawValue && body.count >= 8 ? body.u64le(0) : nil
        }
        /// For a file-open answer, the number the phone gave the file.
        public var handle: UInt64? {
            operation == Operation.data.rawValue && body.count >= 8 ? body.u64le(0) : nil
        }
    }

    /// Takes one answer off the front of what has arrived. nil while it is still coming.
    public static func answer(from buffer: inout Data) throws -> Answer? {
        guard buffer.count >= 40 else { return nil }
        guard buffer.sub(0, 8) == magic else {
            throw SignKitError.malformed("the file service said something we do not understand")
        }
        let total = Int(buffer.u64le(8))
        let thisLength = Int(buffer.u64le(16))
        let packetNumber = buffer.u64le(24)
        let operation = buffer.u64le(32)
        guard total >= 40, total < 1 << 30, thisLength >= 40, thisLength <= total else {
            throw SignKitError.malformed("the file service sent a packet of a silly size")
        }
        guard buffer.count >= total else { return nil }
        let body = total > 40 ? buffer.sub(40, total - 40) : Data()
        buffer = buffer.count > total ? buffer.sub(total, buffer.count - total) : Data()
        return Answer(operation: operation, packetNumber: packetNumber, body: body)
    }

    static func le64(_ value: UInt64) -> Data {
        var out = Data()
        for shift in stride(from: 0, to: 64, by: 8) {
            out.append(UInt8(truncatingIfNeeded: value >> UInt64(shift)))
        }
        return out
    }

    /// Where an app waiting to be installed goes, which is the folder iOS itself uses.
    public static let stagingFolder = "PublicStaging"
}
