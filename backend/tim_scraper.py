import asyncio
import sys
import logging
import os
import random
from datetime import datetime
from playwright.async_api import async_playwright
from playwright_stealth.stealth import Stealth
from dotenv import load_dotenv

load_dotenv()

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger(__name__)

# Textos-chave usados para detectar o estado "sem faturas pendentes"
ALL_PAID_KEYWORDS = [
    "suas contas estão todas pagas",
    "contas estão todas pagas",
    "próximas faturas iremos apresentar aqui",
]


async def scrape_tim() -> dict:
    """
    Automação para buscar faturas pendentes do plano TIM Movel
    via portal Meu TIM (meuplano2.tim.com.br).
    Usa TIM_PHONE e TIM_PASSWORD do arquivo .env.
    """
    load_dotenv(override=True)
    phone = os.getenv("TIM_PHONE")
    password = os.getenv("TIM_PASSWORD")

    if not phone or not password:
        return {
            "status": "error",
            "message": "Variáveis TIM_PHONE e/ou TIM_PASSWORD não encontradas no arquivo .env local do servidor."
        }

    logger.info("Iniciando rotina Playwright para acessar o portal Meu TIM.")

    os.makedirs("tmp", exist_ok=True)

    display = None
    if sys.platform.startswith("linux"):
        try:
            from pyvirtualdisplay import Display
            logger.info("Sistema Linux detectado. Iniciando Display Virtual (Xvfb) para suportar headless=False...")
            display = Display(visible=0, size=(1280, 720))
            display.start()
        except ImportError:
            logger.warning("pyvirtualdisplay nao esta instalado. Tentando rodar sem Xvfb interno.")
        except Exception as e:
            logger.error(f"Erro ao iniciar display virtual: {e}")

    try:
        async with async_playwright() as p:
            browser = await p.chromium.launch(
                headless=False,
                args=[
                    '--window-position=-32000,-32000',
                    '--window-size=1280,720',
                ]
            )

            context = await browser.new_context(
                viewport={'width': 1280, 'height': 720},
                user_agent='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            )

            page = await context.new_page()
            await Stealth().apply_stealth_async(page)

            try:
                # === Stage 1: Navegar para o Meu TIM ===
                url_meutim = "https://meuplano2.tim.com.br/home"
                logger.info(f"Navegando para {url_meutim}...")
                await page.goto(url_meutim, wait_until="domcontentloaded", timeout=60000)
                await page.wait_for_timeout(3000)
                
                # === Stage 2: Aguardar e Cookies ===
                logger.info("Aguardando motor do Flutter e verificação de Cookies...")
                await page.wait_for_timeout(8000) 
                await page.screenshot(path="tmp/01_tim_login_page.png")

                logger.info("Verificando se existe banner de cookies...")
                try:
                    for text in ["Aceitar", "Dispensar", "Concordar"]:
                        btn = page.get_by_role("button", name=text, exact=False).first
                        if await btn.is_visible(timeout=3000):
                            await btn.click()
                            logger.info(f"Banner de cookies: Clicado em '{text}'.")
                            await page.wait_for_timeout(2000)
                            break
                except Exception as e:
                    logger.debug(f"Sem banner de cookies detectado via role: {str(e)}")

                # === Stage 3: Ativar Acessibilidade (Flutter Canvas Hack) ===
                logger.info("Tentando ativar camada de acessibilidade do Flutter...")
                # Clicar no link "Acessibilidade" no topo esquerdo (baseado em screenshot 1280x720)
                await page.mouse.click(280, 20)
                await page.wait_for_timeout(3000)
                await page.screenshot(path="tmp/01b_tim_ready_to_login.png")

                # === Stage 4: Preencher Login (Interação recalibrada por coordenadas) ===
                logger.info("Preenchendo campos de login...")
                
                # Focar campo de telefone via clique
                logger.info("Focando campo de telefone via clique em (640, 230)...")
                await page.mouse.click(640, 230)
                await page.wait_for_timeout(1000)
                
                logger.info("Limpando e digitando telefone...")
                await page.keyboard.press("Control+A")
                await page.keyboard.press("Backspace")
                await page.keyboard.type(phone, delay=200)

                await page.wait_for_timeout(1000)
                await page.screenshot(path="tmp/01c_tim_phone_filled.png")
                
                # Ir para campo de senha
                logger.info("Focando campo de senha em (640, 330)...")
                await page.mouse.click(640, 330)
                await page.wait_for_timeout(1000)
                
                logger.info("Limpando e digitando senha...")
                await page.keyboard.press("Control+A")
                await page.keyboard.press("Backspace")
                await page.keyboard.type(password, delay=200)

                await page.wait_for_timeout(1000)
                await page.screenshot(path="tmp/02_tim_credentials_filled.png")

                # Submeter login
                logger.info("Submetendo login (clique em 640, 450)...")
                # Clicar no botão 'Entrar'
                await page.mouse.click(640, 450)
                await page.wait_for_timeout(1000)

                # Aguardar carregamento pos-login
                logger.info("Aguardando carregamento pos-login...")
                await page.wait_for_timeout(10000)
                await page.screenshot(path="tmp/03_tim_post_login.png")

                body_text = await page.inner_text("body")
                
                # Checar se o sistema da TIM está fora do ar
                if "indisponível" in body_text.lower() or "tente novamente" in body_text.lower():
                    logger.warning("Sistema da TIM está indisponível no momento.")
                    return {"status": "error", "message": "O sistema do portal Meu TIM encontra-se indisponível no momento (Erro do servidor TIM)."}

                # Lidar com telas intermediárias (ex: "Desligue o wi-fi")
                body_text = await page.inner_text("body")
                if "desligue o wi-fi" in body_text.lower() or "continuar" in body_text.lower() or "wifi" in body_text.lower() or "CHIP" in body_text:
                    logger.info("Tela intermediária detectada. Tentando prosseguir...")
                    # Focar e dar enter se for focusable
                    await page.keyboard.press("Tab")
                    await page.keyboard.press("Enter")
                    await page.wait_for_timeout(1000)
                    # Fallback de clique (provavelmente no meio da tela no alerta)
                    await page.mouse.click(640, 400) # Coordenada aproximada do botão continuar alerta
                    await page.wait_for_timeout(8000)
                    await page.screenshot(path="tmp/04_tim_home_logged.png")

                # === Stage 5: Navegar para a secao "Contas" ===
                logger.info("Navegando para a seção 'Contas'...")
                
                # Com base no screenshot, a navegação é uma bottom bar com 4 itens:
                # Plano | Extrato | Contas | Store
                # Em viewport 1280x720, com margens da página. O ícone 'Contas'
                # está em aproximadamente X=720, encostado no fundo (Y=700)
                
                logger.info("Espirrando cliques na região do botão 'Contas' na bottom bar...")
                # Um pequeno grid de cliques para garantir que vamos acertar a hitbox exata do Flutter
                for cx in [680, 700, 720, 740]:
                    for cy in [680, 700, 710]:
                        await page.mouse.click(cx, cy)
                        await page.wait_for_timeout(100)

                logger.info("Aguardando carregamento da aba Contas...")
                await page.wait_for_timeout(10000)
                await page.screenshot(path="tmp/05_tim_contas_page.png")

                # === Stage 6: Verificar status das contas (Tenta via DOM e depois via OCR) ===
                logger.info("Analisando conteudo da pagina de contas via DOM...")
                
                # Reativar acessibilidade para expor o texto do CanvasKit
                try:
                    acc_btn = page.locator('flt-semantics-placeholder[role="button"]').first
                    if await acc_btn.is_visible(timeout=5000):
                        await acc_btn.click(force=True)
                        await page.wait_for_timeout(3000)
                except:
                    pass

                contas_text = await page.inner_text("body")
                contas_lower = contas_text.lower()
                is_all_paid_dom = any(kw in contas_lower for kw in ALL_PAID_KEYWORDS)

                if is_all_paid_dom:
                    logger.info("Cenário detectado via DOM: Todas as contas estão pagas.")
                    return {
                        "status": "info",
                        "message": "Todas as contas TIM estão pagas. Nenhuma fatura em aberto no momento."
                    }

                # === Stage 7: Extrair dados via OCR da pagina atual ===
                # Se não achou "pagas" no DOM, tenta usar o OCR nativo do Gemini na imagem da tela
                logger.info("Fatura em aberto possivelmente detectada! Extraindo dados da tela...")
                # Usa o screenshot existente do Contas page em vez de tirar outro
                await page.screenshot(path="tmp/06_tim_fatura_aberta.png")
                screenshot_path = os.path.abspath("tmp/06_tim_fatura_aberta.png")
                
                try:
                    with open(screenshot_path, "rb") as img_file:
                        img_bytes = img_file.read()

                    from ai_service import extract_invoice_data
                    ocr_response = extract_invoice_data(img_bytes, "image/png")

                    if ocr_response.get("status") == "error":
                        raise Exception(ocr_response.get("details", "Erro do Gemini sem detalhes."))

                    extracted = ocr_response.get("extracted_data", {})
                    amount_raw = extracted.get("amount")
                    amount_val = 0.0
                    if amount_raw is not None:
                        try:
                            amount_val = float(amount_raw)
                        except:
                            pass
                    
                    # Verificação crucial: Se o OCR retornou zerado, significa que a tela 
                    # "Que ótimo. Suas contas estão todas pagas" está presente, mas o DOM ocultou.
                    if amount_val == 0.0 and not extracted.get("barcode") and not extracted.get("due_date"):
                        logger.info("OCR não detectou dados de fatura (0.0). Assumindo que todas as contas estão pagas com base na interface visual.")
                        return {
                            "status": "info",
                            "message": "Todas as contas TIM estão pagas. Nenhuma fatura em aberto no momento."
                        }
                    
                    now = datetime.now()
                    due_date_str = extracted.get("due_date", "")
                    
                    # Inferir mes/ano da data de vencimento em vez de datetime.now() para evitar descompasso no agendamento
                    due_month = now.month
                    due_year = now.year
                    if due_date_str and "-" in due_date_str:
                        try:
                            parts = due_date_str.split("-")
                            if len(parts) >= 2:
                                due_year = int(parts[0])
                                due_month = int(parts[1])
                        except:
                            pass

                    return {
                        "status": "success",
                        "description": f"Conta TIM Movel - {due_month:02d}/{due_year}",
                        "amount": amount_val,
                        "due_date": due_date_str,
                        "barcode": str(extracted.get("barcode", "") or ""),
                        "message": "Fatura TIM extraída e processada via OCR Gemini."
                    }

                except Exception as ocr_err:
                    logger.warning(f"OCR falhou na fatura TIM: {str(ocr_err)}")
                    return {
                        "status": "error",
                        "message": f"Fatura encontrada, mas extração OCR falhou: {str(ocr_err)}"
                    }

            except Exception as err:
                error_msg = str(err)
                logger.error(f"Erro Playwright na navegacao do Meu TIM: {error_msg}")
                
                try:
                    if not page.is_closed():
                        await page.screenshot(path="tmp/tim_error.png")
                except:
                    pass
                    
                return {"status": "error", "message": f"Erro técnico no scraper TIM: {error_msg}"}

            finally:
                await browser.close()
    
    finally:
        if display:
            display.stop()


if __name__ == "__main__":
    resultado = asyncio.run(scrape_tim())
    print("\n[Modulo de Scraping TIM Movel]:")
    print(resultado)
