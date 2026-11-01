import shutil
import subprocess


def speak(text: str) -> bool:
    """Speak text using espeak-ng, espeak, or pyttsx3."""
    if not text or not text.strip():
        return False

    # Prefer the system speech engine on Ubuntu/WSL.
    for engine in ("espeak-ng", "espeak"):
        executable = shutil.which(engine)

        if executable:
            try:
                result = subprocess.run(
                    [executable, text],
                    check=False,
                    timeout=30,
                    capture_output=True,
                    text=True,
                )

                if result.returncode == 0:
                    return True

                print(f"{engine} failed: {result.stderr.strip()}")

            except (subprocess.SubprocessError, OSError) as exc:
                print(f"{engine} error: {exc}")

    # Fallback to pyttsx3 if the system engines are unavailable.
    try:
        import pyttsx3

        engine = pyttsx3.init()
        engine.say(text)
        engine.runAndWait()
        engine.stop()
        return True

    except Exception as exc:
        print(f"Speech output unavailable: {exc}")
        return False
