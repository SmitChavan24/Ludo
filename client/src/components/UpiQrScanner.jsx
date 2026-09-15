import { useEffect, useRef, useState } from 'react';
import { decodeQrFromFile, decodeQrFromVideo, extractUpiId, extractPayeeName } from '../util/upiQr.js';

// Scan or upload a UPI QR to fill in a UPI ID.
//
// Typing a UPI ID by hand is where payouts go wrong — one wrong character sends
// real money to a stranger, with no way back. Scanning removes that risk.
export default function UpiQrScanner({ onFound, onClose }) {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const rafRef = useRef(null);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  // Always release the camera — leaving it on is a privacy problem, and on
  // mobile it keeps the indicator lit and drains the battery.
  const stopCamera = () => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setScanning(false);
  };
  useEffect(() => stopCamera, []);

  const handleResult = (raw) => {
    const upiId = extractUpiId(raw);
    if (!upiId) {
      setError("That QR doesn't contain a UPI ID. Try your UPI app's 'My QR' code.");
      return false;
    }
    stopCamera();
    onFound?.(upiId, extractPayeeName(raw));
    return true;
  };

  const startCamera = async () => {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' }, // rear camera on phones
      });
      streamRef.current = stream;
      setScanning(true);
      const video = videoRef.current;
      video.srcObject = stream;
      await video.play();

      const tick = async () => {
        if (!streamRef.current) return;
        try {
          const raw = await decodeQrFromVideo(video);
          if (raw && handleResult(raw)) return;
        } catch {
          /* keep scanning */
        }
        rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);
    } catch {
      setError('Could not open the camera. You can upload a screenshot of your QR instead.');
      setScanning(false);
    }
  };

  const onFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    setBusy(true);
    try {
      const raw = await decodeQrFromFile(file);
      if (!raw) setError('No QR code found in that image. Try a clearer, closer photo.');
      else handleResult(raw);
    } catch {
      setError('Could not read that image.');
    } finally {
      setBusy(false);
      e.target.value = ''; // allow re-picking the same file
    }
  };

  return (
    <div className="qr-scanner">
      <div className="qr-head">
        <span>Scan your UPI QR</span>
        <button className="x-btn" onClick={() => { stopCamera(); onClose?.(); }} aria-label="Close">✕</button>
      </div>

      {scanning ? (
        <div className="qr-video-wrap">
          <video ref={videoRef} className="qr-video" playsInline muted />
          <div className="qr-frame" aria-hidden />
          <p className="qr-hint">Point the camera at your UPI QR code</p>
          <button className="btn btn-ghost btn-block btn-sm" onClick={stopCamera}>Stop camera</button>
        </div>
      ) : (
        <>
          <button className="btn btn-secondary btn-block" onClick={startCamera}>📷 Scan with camera</button>
          <label className="btn btn-outline btn-block qr-upload">
            {busy ? 'Reading…' : '🖼️ Upload QR image'}
            <input type="file" accept="image/*" onChange={onFile} hidden disabled={busy} />
          </label>
          <p className="qr-note">
            Open any UPI app → <b>My QR</b> → screenshot it, or scan it directly.
          </p>
        </>
      )}

      {error && <p className="error-text">{error}</p>}
    </div>
  );
}
