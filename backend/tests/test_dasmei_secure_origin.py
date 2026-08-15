from dasmei_scraper import PGMEI_URL, _is_trusted_pgmei_url


def test_pgmei_entrypoint_and_final_origin_require_https_receita_host():
    assert PGMEI_URL.startswith("https://")
    assert _is_trusted_pgmei_url(PGMEI_URL) is True
    assert (
        _is_trusted_pgmei_url(
            "https://www8.receita.fazenda.gov.br/SimplesNacional/Aplicacoes/ATSPO/pgmei.app/emissao"
        )
        is True
    )
    assert _is_trusted_pgmei_url("https://www8.receita.fazenda.gov.br:443/pgmei") is True


def test_pgmei_origin_rejects_downgrade_cross_origin_or_nonstandard_port():
    assert (
        _is_trusted_pgmei_url(
            "http://www8.receita.fazenda.gov.br/SimplesNacional/Aplicacoes/ATSPO/pgmei.app/Identificacao"
        )
        is False
    )
    assert _is_trusted_pgmei_url("https://receita.example.net/pgmei") is False
    assert _is_trusted_pgmei_url("https://www8.receita.fazenda.gov.br.evil.example/pgmei") is False
    assert _is_trusted_pgmei_url("https://www8.receita.fazenda.gov.br:444/pgmei") is False
    assert _is_trusted_pgmei_url("https://www8.receita.fazenda.gov.br:notaport/pgmei") is False
    assert _is_trusted_pgmei_url("not-a-url") is False
