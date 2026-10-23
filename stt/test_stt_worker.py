"""Tests for the watch speech-to-text worker.

Run: stt\\.venv\\Scripts\\python.exe -m unittest stt/test_stt_worker.py -v
"""

import json
import sys
import unittest
from pathlib import Path

import numpy as np

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))

import stt_worker  # noqa: E402

FIXTURE = (HERE / "fixtures" / "weather.opus").read_bytes()


class WatchMp3(unittest.TestCase):
    """Spoken answers: small mono MP3s the watch's Player can play (MP3 only; Opus must be recorded on the watch)."""

    def test_encode_round_trip(self):
        pcm = stt_worker.decode(FIXTURE)
        mp3 = stt_worker.encode_mp3(pcm)
        self.assertTrue(mp3[:3] == b"ID3" or (mp3[0] == 0xFF and mp3[1] & 0xE0 == 0xE0), mp3[:4])
        back = stt_worker.decode_audio(mp3)
        self.assertAlmostEqual(len(back) / 16000, len(pcm) / 16000, delta=0.3)

    def test_small_enough_for_bluetooth(self):
        pcm = stt_worker.decode(FIXTURE)
        mp3 = stt_worker.encode_mp3(pcm)
        self.assertLess(len(mp3) / (len(pcm) / 16000), 2400)  # bytes per second of speech (~16 kbps)

    @unittest.skipUnless(__import__("os").environ.get("TTS_LIVE") == "1", "set TTS_LIVE=1 (needs the internet)")
    def test_speak_live(self):
        mp3 = stt_worker.speak("Hello from Hermes.")
        self.assertGreater(len(stt_worker.decode_audio(mp3)) / 16000, 0.5)


class TtsLocal(unittest.TestCase):
    """TTS speaks through the local OpenAI-compatible endpoint (Kokoro); there is no cloud fallback."""

    def _speak(self, text="Hello from Hermes."):
        import http.server
        import threading

        seen = {}

        class Capture(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                n = int(self.headers.get("Content-Length") or 0)
                seen["path"] = self.path
                seen["auth"] = self.headers.get("Authorization")
                seen["body"] = json.loads(self.rfile.read(n))
                payload = b"FAKE-MP3"
                self.send_response(200)
                self.send_header("Content-Type", "audio/mpeg")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            def log_message(self, *args):
                pass

        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Capture)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.shutdown)
        saved_url, saved_key = stt_worker.TTS_URL, stt_worker.TTS_API_KEY
        stt_worker.TTS_URL = f"http://127.0.0.1:{server.server_address[1]}"
        self.addCleanup(setattr, stt_worker, "TTS_URL", saved_url)
        self.addCleanup(setattr, stt_worker, "TTS_API_KEY", saved_key)
        raw = {}
        saved_encode, saved_decode = stt_worker.encode_mp3, stt_worker.decode_audio
        stt_worker.decode_audio = lambda data: raw.setdefault("in", data)
        stt_worker.encode_mp3 = lambda pcm: b"ENC(\x00)"
        self.addCleanup(setattr, stt_worker, "encode_mp3", saved_encode)
        self.addCleanup(setattr, stt_worker, "decode_audio", saved_decode)
        try:
            out = stt_worker.speak(text)
        finally:
            server.server_close()
        return seen, raw, out

    def test_request_shape(self):
        stt_worker.TTS_API_KEY = "kokoro-key"
        seen, raw, out = self._speak()
        self.assertEqual(seen["path"], "/v1/audio/speech")
        self.assertEqual(seen["body"], {"input": "Hello from Hermes.", "voice": stt_worker.TTS_VOICE,
                                        "response_format": "mp3"})
        self.assertEqual(seen["auth"], "Bearer kokoro-key")
        self.assertEqual(raw["in"], b"FAKE-MP3")  # the endpoint's MP3 is re-encoded for Bluetooth
        self.assertEqual(out, b"ENC(\x00)")

    def test_no_endpoint_set(self):
        saved = stt_worker.TTS_URL
        stt_worker.TTS_URL = ""
        self.addCleanup(setattr, stt_worker, "TTS_URL", saved)
        with self.assertRaises(RuntimeError):
            stt_worker.speak("Hello")

    def test_endpoint_error_raises(self):
        import urllib.error
        import urllib.request

        stt_worker.TTS_URL = "http://127.0.0.1:1"
        self.addCleanup(setattr, stt_worker, "TTS_URL", "")
        saved = urllib.request.urlopen

        def fail(*args, **kwargs):
            raise urllib.error.HTTPError("http://127.0.0.1:1/v1/audio/speech", 500, "boom", {}, None)

        urllib.request.urlopen = fail
        self.addCleanup(setattr, urllib.request, "urlopen", saved)
        with self.assertRaises(urllib.error.HTTPError):
            stt_worker.speak("Hello")


class SplitPackets(unittest.TestCase):
    def test_split_packets_fixture(self):
        packets = stt_worker.split_packets(FIXTURE)
        self.assertTrue(packets)
        self.assertEqual(packets[0][0], 0x48)

    def test_split_packets_rejects_garbage(self):
        self.assertIsNone(stt_worker.split_packets(b"hello world!" * 10))


class Decode(unittest.TestCase):
    def test_decode_length(self):
        pcm = stt_worker.decode(FIXTURE)
        self.assertEqual(pcm.dtype, np.int16)
        self.assertTrue(2.5 <= len(pcm) / 16000 <= 4.0, len(pcm) / 16000)

    def test_truncated_last_packet_dropped(self):
        pcm = stt_worker.decode(FIXTURE[:-5])
        self.assertGreater(len(pcm) / 16000, 2.5)


class Transcribe(unittest.TestCase):
    def test_transcribe_fixture(self):
        text = stt_worker.transcribe(stt_worker.decode(FIXTURE)).lower()
        self.assertIn("weather", text)
        self.assertIn("paris", text)

    def test_silence(self):
        self.assertEqual(stt_worker.transcribe(np.zeros(16000, np.int16)), "")


class Log(unittest.TestCase):
    def test_log_without_stdout(self):
        # pythonw (the scheduled task) has no stdout: lines go to stt.log instead.
        import io
        import tempfile
        saved_stdout, saved_file = sys.stdout, stt_worker.LOG_FILE
        with tempfile.TemporaryDirectory() as tmp:
            stt_worker.LOG_FILE = Path(tmp) / "stt.log"
            sys.stdout = None
            try:
                stt_worker.log("hello log")
            finally:
                sys.stdout, stt_worker.LOG_FILE = saved_stdout, saved_file
            self.assertIn("hello log", (Path(tmp) / "stt.log").read_text())
        buf = io.StringIO()
        sys.stdout = buf
        try:
            stt_worker.log("to stdout")
        finally:
            sys.stdout = saved_stdout
        self.assertIn("to stdout", buf.getvalue())


if __name__ == "__main__":
    unittest.main()
