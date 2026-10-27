import XCTest
@testable import SignKit

/// Reading the classes out of a real program and writing them back as headers (classdump).
final class ObjCDumpTests: XCTestCase {
    func programInsideASampleApp() throws -> MachOSlice {
        let paths = ["/projects/sandbox/research/ipa/Feather.ipa",
                     "/projects/sandbox/research/ipa/Ksign.ipa"]
        guard let found = paths.first(where: { FileManager.default.fileExists(atPath: $0) }) else {
            throw XCTSkip("no sample .ipa in this environment")
        }
        let ipa = URL(fileURLWithPath: found)
        let reader = try ZipReader(url: ipa)
        let appDir = try AppContents.appDirectory(reader)
        let info = try PropertyListSerialization.propertyList(
            from: try AppContents.read(inIPA: ipa, path: "Info.plist"), format: nil) as? [String: Any] ?? [:]
        let executable = try XCTUnwrap(info["CFBundleExecutable"] as? String)
        let entry = try XCTUnwrap(reader.entries.first { $0.name == appDir + executable })
        let file = try MachOFile(data: try reader.data(for: entry))
        return try XCTUnwrap(file.slices.first { $0.is64 })
    }

    func testReadsRealClassesOutOfARealApp() throws {
        let dump = ObjCDump.read(try programInsideASampleApp())
        XCTAssertGreaterThan(dump.classes.count, 20, "a real app defines plenty of classes")
        XCTAssertFalse(dump.isEmpty)

        // Names are real names, not rubbish from pointers we followed wrongly.
        for klass in dump.classes {
            XCTAssertFalse(klass.name.isEmpty)
            XCTAssertFalse(klass.name.contains("\u{0}"))
            XCTAssertLessThan(klass.name.count, 200, klass.name)
        }
        // Names are unique: the same class listed twice is folded into one.
        XCTAssertEqual(Set(dump.classes.map(\.name)).count, dump.classes.count)

        // Parents are found, including classes that live in iOS itself (a bind, not a pointer).
        let withParents = dump.classes.filter { $0.superName?.isEmpty == false }
        XCTAssertGreaterThan(withParents.count, dump.classes.count / 2,
                             "most classes should have their parent worked out")
        XCTAssertTrue(dump.classes.contains { $0.superName == "NSObject" }
                      || dump.classes.contains { $0.superName?.contains("SwiftObject") == true },
                      "the usual parents should turn up by name")

        // Methods read, with types that decoded into something.
        let withMethods = dump.classes.filter { !$0.methods.isEmpty }
        XCTAssertFalse(withMethods.isEmpty, "a real app answers messages")
        for method in withMethods.flatMap(\.methods).prefix(200) {
            XCTAssertTrue(method.line.hasPrefix("- ") || method.line.hasPrefix("+ "), method.line)
            XCTAssertTrue(method.line.hasSuffix(";"), method.line)
        }

        let headers = dump.headers()
        XCTAssertTrue(headers.contains("@interface"))
        XCTAssertTrue(headers.contains("@end"))
        XCTAssertGreaterThan(headers.count, 2000)
    }

    func testDecodesApplesShortTypes() {
        XCTAssertEqual(ObjCDump.Types.readable("v"), "void")
        XCTAssertEqual(ObjCDump.Types.readable("@\"NSString\""), "NSString *")
        XCTAssertEqual(ObjCDump.Types.readable("@"), "id")
        XCTAssertEqual(ObjCDump.Types.readable("@?"), "id /* block */")
        XCTAssertEqual(ObjCDump.Types.readable("^@"), "id *")
        XCTAssertEqual(ObjCDump.Types.readable("B"), "BOOL")
        XCTAssertEqual(ObjCDump.Types.readable("Q"), "unsigned long long")
        XCTAssertEqual(ObjCDump.Types.readable("{CGRect=dddd}"), "struct CGRect")
        XCTAssertEqual(ObjCDump.Types.readable("[8i]"), "int[8]")
        XCTAssertEqual(ObjCDump.Types.readable("r*"), "char *")
    }

    func testSplitsAMethodsTypes() {
        // void, self, selector, one object: the shape every setter has.
        XCTAssertEqual(ObjCDump.Types.split("v24@0:8@16"), ["void", "id", "SEL", "id"])
        XCTAssertEqual(ObjCDump.Types.split("@16@0:8"), ["id", "id", "SEL"])
        XCTAssertEqual(ObjCDump.Types.split("v32@0:8@\"NSString\"16q24"),
                       ["void", "id", "SEL", "NSString *", "long long"])
    }

    func testWritesAMethodLine() {
        XCTAssertEqual(ObjCDump.line(selector: "viewDidLoad", types: "v16@0:8", classMethod: false),
                       "- (void)viewDidLoad;")
        XCTAssertEqual(ObjCDump.line(selector: "setName:", types: "v24@0:8@\"NSString\"16",
                                     classMethod: false),
                       "- (void)setName:(NSString *)arg1;")
        XCTAssertEqual(ObjCDump.line(selector: "sharedThing", types: "@16@0:8", classMethod: true),
                       "+ (id)sharedThing;")
        XCTAssertEqual(ObjCDump.line(selector: "a:b:", types: "v32@0:8@16q24", classMethod: false),
                       "- (void)a:(id)arg1 b:(long long)arg2;")
    }

    func testPutsSwiftNamesBackTogether() {
        XCTAssertEqual(ObjCDump.unmangle("_TtC11BitByteData12LsbBitReader"), "BitByteData.LsbBitReader")
        XCTAssertEqual(ObjCDump.unmangle("_TtC7Feather11AppDelegate"), "Feather.AppDelegate")
        XCTAssertNil(ObjCDump.unmangle("NSObject"))
        XCTAssertNil(ObjCDump.unmangle("_TtC"))
    }

    func testPropertyLines() {
        XCTAssertEqual(ObjCDump.Types.property(name: "bundle", attributes: "T@\"NSBundle\",&,N,V_bundle"),
                       "@property (retain, nonatomic) NSBundle *bundle;")
        XCTAssertEqual(ObjCDump.Types.property(name: "count", attributes: "Tq,R,N"),
                       "@property (readonly, nonatomic) long long count;")
    }
}
