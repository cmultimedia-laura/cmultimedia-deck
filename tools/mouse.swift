// Pilote du pointeur du Mac pour le trackpad de l'iPad. Lit des ordres sur l'entrée standard, une ligne par ordre :
//   m dx dy   déplacement relatif      c l | c r | c d   clic gauche / droit / double
//   s dy dx   défilement               d down | d up     glisser-déposer (bouton maintenu / relâché)
//   t <base64>  frappe d'un texte (Unicode)   k code drapeaux   touche avec modificateurs (⌘ ⇧ ⌥ ⌃)
// Écrit « pret » ou « refus » (autorisation Accessibilité de macOS) au démarrage.
import AppKit
import CoreGraphics

setvbuf(stdout, nil, _IONBF, 0)
let trusted = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary)
print(trusted ? "pret" : "refus")
if !trusted { exit(2) }

var dragging = false
func pos() -> CGPoint { return CGEvent(source: nil)?.location ?? .zero }
func bounds() -> CGRect {
    var r = CGRect.null
    var count: UInt32 = 0; CGGetActiveDisplayList(0, nil, &count)
    var ids = [CGDirectDisplayID](repeating: 0, count: Int(count)); CGGetActiveDisplayList(count, &ids, &count)
    for d in ids { r = r.union(CGDisplayBounds(d)) }
    return r
}
let all = bounds()
func post(_ t: CGEventType, _ p: CGPoint, _ b: CGMouseButton, clicks: Int64 = 1) {
    if let e = CGEvent(mouseEventSource: nil, mouseType: t, mouseCursorPosition: p, mouseButton: b) {
        e.setIntegerValueField(.mouseEventClickState, value: clicks); e.post(tap: .cghidEventTap)
    }
}
while let line = readLine() {
    let f = line.split(separator: " ").map(String.init)
    guard let cmd = f.first else { continue }
    switch cmd {
    case "m":
        guard f.count == 3, let dx = Double(f[1]), let dy = Double(f[2]) else { continue }
        var p = pos(); p.x = min(max(p.x + dx, all.minX), all.maxX - 1); p.y = min(max(p.y + dy, all.minY), all.maxY - 1)
        post(dragging ? .leftMouseDragged : .mouseMoved, p, .left)
    case "c":
        let p = pos()
        if f.count > 1 && f[1] == "r" { post(.rightMouseDown, p, .right); post(.rightMouseUp, p, .right) }
        else if f.count > 1 && f[1] == "d" { post(.leftMouseDown, p, .left, clicks: 1); post(.leftMouseUp, p, .left, clicks: 1); post(.leftMouseDown, p, .left, clicks: 2); post(.leftMouseUp, p, .left, clicks: 2) }
        else { post(.leftMouseDown, p, .left); post(.leftMouseUp, p, .left) }
    case "s":
        guard f.count >= 2, let dy = Int32(f[1]) else { continue }
        let dx = f.count > 2 ? (Int32(f[2]) ?? 0) : 0
        CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2, wheel1: dy, wheel2: dx, wheel3: 0)?.post(tap: .cghidEventTap)
    case "d":
        let p = pos()
        if f.count > 1 && f[1] == "down" && !dragging { dragging = true; post(.leftMouseDown, p, .left) }
        else if f.count > 1 && f[1] == "up" && dragging { dragging = false; post(.leftMouseUp, p, .left) }
    case "t":
        guard f.count == 2, let data = Data(base64Encoded: f[1]), let text = String(data: data, encoding: .utf8) else { continue }
        for ch in text {
            if ch == "\n" { for down in [true, false] { CGEvent(keyboardEventSource: nil, virtualKey: 36, keyDown: down)?.post(tap: .cghidEventTap) }; continue }
            let u = Array(String(ch).utf16)
            for down in [true, false] {
                if let e = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: down) { e.keyboardSetUnicodeString(stringLength: u.count, unicodeString: u); e.post(tap: .cghidEventTap) }
            }
            usleep(4000)
        }
    case "k":
        guard f.count == 3, let code = UInt16(f[1]), let fl = UInt64(f[2]) else { continue }
        for down in [true, false] {
            if let e = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: down) { e.flags = CGEventFlags(rawValue: fl); e.post(tap: .cghidEventTap) }
        }
    default: continue
    }
}
if dragging { post(.leftMouseUp, pos(), .left) }
