// Exporte la vraie icône (celle du Finder et du Dock) d'applications en PNG 96 × 96.
// Usage : swift tools/app-icons.swift <dossier_sortie> "<id>|<chemin.app>" ...
import AppKit

let outDir = CommandLine.arguments[1]
for pair in CommandLine.arguments.dropFirst(2) {
    let parts = pair.components(separatedBy: "|")
    guard parts.count == 2 else { continue }
    let img = NSWorkspace.shared.icon(forFile: parts[1])
    let px = 96
    guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px, bitsPerSample: 8, samplesPerPixel: 4,
                                     hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0) else { continue }
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    img.draw(in: NSRect(x: 0, y: 0, width: px, height: px))
    NSGraphicsContext.restoreGraphicsState()
    if let data = rep.representation(using: .png, properties: [:]) {
        try? data.write(to: URL(fileURLWithPath: outDir + "/" + parts[0] + ".png"))
    }
}
