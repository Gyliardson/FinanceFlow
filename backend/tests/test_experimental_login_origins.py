from pathlib import Path

from tim_scraper import _is_trusted_tim_url
from unopar_scraper import _is_trusted_unopar_url


BACKEND_DIR = Path(__file__).resolve().parents[1]


def test_tim_login_origin_accepts_only_expected_https_host():
    assert _is_trusted_tim_url("https://meuplano2.tim.com.br/home") is True
    assert _is_trusted_tim_url("https://meuplano2.tim.com.br:443/home") is True

    for url in (
        "http://meuplano2.tim.com.br/home",
        "https://evil.example/home",
        "https://meuplano2.tim.com.br.evil.example/home",
        "https://meuplano2.tim.com.br:444/home",
        "not-a-url",
    ):
        assert _is_trusted_tim_url(url) is False


def test_unopar_login_origin_accepts_only_expected_https_host():
    assert _is_trusted_unopar_url("https://login.unopar.br") is True
    assert _is_trusted_unopar_url("https://login.unopar.br:443/path") is True

    for url in (
        "http://login.unopar.br",
        "https://evil.example",
        "https://login.unopar.br.evil.example",
        "https://login.unopar.br:444",
        "not-a-url",
    ):
        assert _is_trusted_unopar_url(url) is False


def test_tim_credentials_cannot_be_filled_before_secure_origin_guards():
    source = (BACKEND_DIR / "tim_scraper.py").read_text(encoding="utf-8")

    goto = source.index("await page.goto(")
    first_guard = source.index("if not _is_trusted_tim_url(page.url):", goto)
    phone_fill = source.index("await phone_input.fill(phone)", first_guard)
    second_guard = source.rindex(
        "if not _is_trusted_tim_url(page.url):",
        first_guard,
        phone_fill,
    )
    password_fill = source.index("await password_input.fill(password)", phone_fill)
    password_guard = source.rindex(
        "if not _is_trusted_tim_url(page.url):",
        phone_fill,
        password_fill,
    )

    assert goto < first_guard <= second_guard < phone_fill < password_guard < password_fill


def test_unopar_identity_and_password_each_have_secure_origin_guard():
    source = (BACKEND_DIR / "unopar_scraper.py").read_text(encoding="utf-8")

    goto = source.index("await page.goto(")
    identity_fill = source.index("await identity_input.fill(student_id)", goto)
    identity_guard = source.rindex(
        "if not _is_trusted_unopar_url(page.url):",
        goto,
        identity_fill,
    )
    identity_submit = source.index('await identity_input.press("Enter")', identity_fill)
    password_fill = source.index("await password_input.fill(password)", identity_submit)
    password_guard = source.rindex(
        "if not _is_trusted_unopar_url(page.url):",
        identity_submit,
        password_fill,
    )

    assert goto < identity_guard < identity_fill < identity_submit < password_guard < password_fill
