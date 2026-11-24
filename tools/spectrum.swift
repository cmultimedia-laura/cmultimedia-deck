// Spectre en direct du son joué par le Mac (ScreenCaptureKit, audio seulement), pour l'animation de la page Musique.
// Rien n'est enregistré : seuls 24 niveaux de bandes (0..99) sont écrits sur la sortie standard, ~20 fois par seconde.
// Première ligne : « pret » ou « refus » (autorisation « Enregistrement de l'écran et de l'audio du système »).
import Foundation
import ScreenCaptureKit
import CoreMedia
import Accelerate

setvbuf(stdout, nil, _IONBF, 0)
let N = 2048, LOG2N = vDSP_Length(11), BANDS = 24
let fftSetup = vDSP_create_fftsetup(LOG2N, FFTRadix(kFFTRadix2))!
var window = [Float](repeating: 0, count: N); vDSP_hann_window(&window, vDSP_Length(N), Int32(vDSP_HANN_NORM))
var ring = [Float](); var sampleRate: Double = 48000
var lastEmit = Date.distantPast
var smooth = [Float](repeating: 0, count: BANDS)
var floorDb = [Float](repeating: -999, count: BANDS), ceilDb = [Float](repeating: -999, count: BANDS)

func emit() {
    guard ring.count >= N else { return }
    let frame = Array(ring.suffix(N)); ring.removeFirst(max(0, ring.count - N))
    var x = [Float](repeating: 0, count: N); vDSP_vmul(frame, 1, window, 1, &x, 1, vDSP_Length(N))
    var re = [Float](repeating: 0, count: N / 2), im = [Float](repeating: 0, count: N / 2)
    var mags = [Float](repeating: 0, count: N / 2)
    re.withUnsafeMutableBufferPointer { rp in im.withUnsafeMutableBufferPointer { ip in
        var split = DSPSplitComplex(realp: rp.baseAddress!, imagp: ip.baseAddress!)
        x.withUnsafeBufferPointer { xp in xp.baseAddress!.withMemoryRebound(to: DSPComplex.self, capacity: N / 2) { vDSP_ctoz($0, 2, &split, 1, vDSP_Length(N / 2)) } }
        vDSP_fft_zrip(fftSetup, &split, 1, LOG2N, FFTDirection(FFT_FORWARD))
        vDSP_zvabs(&split, 1, &mags, 1, vDSP_Length(N / 2))
    } }
    // 24 bandes logarithmiques de 40 Hz à 16 kHz
    var out = [Int]()
    let binHz = sampleRate / Double(N)
    for b in 0..<BANDS {
        let f0 = 40 * pow(400.0, Double(b) / Double(BANDS)), f1 = 40 * pow(400.0, Double(b + 1) / Double(BANDS))
        let i0 = max(1, Int(f0 / binHz)), i1 = max(i0 + 1, min(N / 2, Int(f1 / binHz)))
        var m: Float = 0; for i in i0..<i1 { m = max(m, mags[i]) }
        let db = 20 * log10(max(m / Float(N), 1e-7))
        // Échelle adaptative par bande : plancher et plafond suivent la musique, la barre montre l'écart (les coups ressortent)
        if floorDb[b] < -900 { floorDb[b] = db - 6; ceilDb[b] = db + 6 }
        floorDb[b] = db < floorDb[b] ? floorDb[b] * 0.7 + db * 0.3 : floorDb[b] + (db - floorDb[b]) * 0.012
        ceilDb[b] = db > ceilDb[b] ? db : ceilDb[b] - (ceilDb[b] - db) * 0.01
        let span = max(ceilDb[b] - floorDb[b], 14)
        var v = max(0, min(1, (db - floorDb[b]) / span))
        v = pow(v, 1.5)
        if db < -95 { v = 0 }   // silence
        smooth[b] = v > smooth[b] ? v : smooth[b] * 0.45 + v * 0.55   // montée immédiate, retombée rapide
        out.append(Int(smooth[b] * 99))
    }
    print("b " + out.map(String.init).joined(separator: " "))
}

final class AudioOut: NSObject, SCStreamOutput, SCStreamDelegate {
    func stream(_ stream: SCStream, didOutputSampleBuffer sb: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .audio, sb.isValid else { return }
        if let fmt = sb.formatDescription?.audioStreamBasicDescription { sampleRate = fmt.mSampleRate }
        try? sb.withAudioBufferList { abl, _ in
            guard let first = abl.first, let data = first.mData else { return }
            let count = Int(first.mDataByteSize) / MemoryLayout<Float>.size
            let p = data.bindMemory(to: Float.self, capacity: count)
            ring.append(contentsOf: UnsafeBufferPointer(start: p, count: count))
            if ring.count > N * 4 { ring.removeFirst(ring.count - N * 2) }
        }
        if Date().timeIntervalSince(lastEmit) > 0.03 { lastEmit = Date(); emit() }
    }
    func stream(_ stream: SCStream, didStopWithError error: Error) { print("arret " + error.localizedDescription); exit(3) }
}

let out = AudioOut()
var streamRef: SCStream?
Task {
    do {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        guard let display = content.displays.first else { print("refus aucun écran"); exit(2) }
        let filter = SCContentFilter(display: display, excludingWindows: [])
        let cfg = SCStreamConfiguration()
        cfg.capturesAudio = true; cfg.excludesCurrentProcessAudio = true; cfg.sampleRate = 48000; cfg.channelCount = 1
        cfg.width = 2; cfg.height = 2; cfg.minimumFrameInterval = CMTime(value: 1, timescale: 1)   // vidéo minimale, ignorée
        let s = SCStream(filter: filter, configuration: cfg, delegate: out)
        try s.addStreamOutput(out, type: .audio, sampleHandlerQueue: DispatchQueue(label: "audio"))
        try await s.startCapture()
        streamRef = s
        print("pret")
    } catch {
        print("refus " + error.localizedDescription); exit(2)
    }
}
// Arrêt propre quand le serveur ferme l'entrée standard
DispatchQueue.global().async { while readLine() != nil {}; exit(0) }
dispatchMain()
