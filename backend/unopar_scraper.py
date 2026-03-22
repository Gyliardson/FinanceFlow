import asyncio
import logging
import os
import re
import random
from datetime import datetime
from playwright.async_api import async_playwright
from playwright_stealth.stealth import Stealth
from dotenv import load_dotenv

load_dotenv()

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger(__name__)

async def scrape_unopar() -> dict:
    """
    Automacao para acessar o Portal do Aluno da Unopar.
    Realiza login com CPF e Senha, acessa o Financeiro,
    clica em Pagar na mensalidade aberta e extrai o codigo PIX Copia e Cola,
    o valor com desconto de pontualidade e a data de pontualidade.
    """
    load_dotenv(override=True)
    ra = os.getenv("UNOPAR_RA")
    password = os.getenv("UNOPAR_PASSWORD")
    
    if not ra or not password:
        return {"status": "error", "message": "Variáveis UNOPAR_RA ou UNOPAR_PASSWORD não encontradas no arquivo .env local do servidor."}

    logger.info("Iniciando rotina Playwright para portal Unopar.")
    os.makedirs("tmp", exist_ok=True)
    
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
            user_agent='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        )
        await context.grant_permissions(["clipboard-read", "clipboard-write"])
        
        page = await context.new_page()
        await Stealth().apply_stealth_async(page)
        
        try:
            # === Stage 1: Acesso ao Portal ===
            logger.info("Acessando login.unopar.br...")
            await page.goto("https://login.unopar.br", wait_until="networkidle", timeout=60000)
            
            # === Stage 2: Inserir CPF ===
            logger.info("Preenchendo CPF...")
            await page.wait_for_selector('input', timeout=20000)
            input_cpf = page.locator('input').first
            await input_cpf.click()
            await page.wait_for_timeout(random.uniform(500, 1000))
            await input_cpf.type(str(ra), delay=random.randint(80, 150))
            await page.wait_for_timeout(1000)
            await page.keyboard.press("Enter")
            
            # === Stage 3: Inserir Senha ===
            logger.info("Aguardando campo de senha...")
            await page.wait_for_timeout(3000)
            input_senha = page.locator('input[type="password"]').first
            await input_senha.wait_for(state="visible", timeout=15000)
            await input_senha.click()
            await page.wait_for_timeout(random.uniform(500, 1000))
            await input_senha.type(str(password), delay=random.randint(80, 150))
            await page.wait_for_timeout(1000)
            await page.keyboard.press("Enter")
            
            # === Stage 4: Aguardar Login e Fechar Popup ===
            logger.info("Aguardando painel carregar...")
            await page.wait_for_load_state("networkidle", timeout=45000)
            await page.wait_for_timeout(5000)
            
            await page.screenshot(path="tmp/unopar_01_painel.png")
            
            # O portal exibe um popup de oferta (ex: Santander Top Espana).
            # Pressionar Escape fecha o modal de forma confiavel.
            logger.info("Fechando popup de oferta (Escape)...")
            await page.keyboard.press("Escape")
            await page.wait_for_timeout(2000)
            
            # === Stage 5: Clicar em Financeiro (menu lateral) ===
            logger.info("Clicando em 'Financeiro' no menu lateral...")
            financeiro = page.locator('text="Financeiro"').first
            await financeiro.click(force=True)
            await page.wait_for_timeout(8000)
            
            await page.screenshot(path="tmp/unopar_02_financeiro.png")
            
            # === Stage 6: Extrair dados da mensalidade do card (antes de clicar Pagar) ===
            logger.info("Extraindo dados da mensalidade do card...")
            body_text = await page.inner_text("body")
            
            # Extrair descricao (ex: "Mensalidade 04")
            desc_match = re.search(r"(Mensalidade\s+\d+)", body_text)
            description = desc_match.group(1) if desc_match else "Mensalidade Unopar"
            
            # Extrair valor (ex: "R$184,64")
            valor_match = re.search(r"Valor:\s*R\$\s*([\d.,]+)", body_text)
            amount_str = valor_match.group(1) if valor_match else "0"
            amount = float(amount_str.replace(".", "").replace(",", "."))
            
            # Extrair data de pontualidade (ex: "08/04/2026")
            pont_match = re.search(r"(?:pontualidade|desconto)\s*(?:até)?:?\s*(\d{2}/\d{2}/\d{4})", body_text, re.IGNORECASE)
            if pont_match:
                d, m, y = pont_match.group(1).split("/")
                due_date = f"{y}-{m}-{d}"
            else:
                due_date = datetime.now().strftime("%Y-%m-%d")
                
            logger.info(f"Card: {description} | R${amount} | Pontualidade: {due_date}")
            
            if "mensalidade encontrada" not in body_text.lower() and "em aberto" not in body_text.lower():
                return {
                    "status": "success",
                    "description": f"{description} - {datetime.now().month:02d}/{datetime.now().year}",
                    "amount": 0.0,
                    "due_date": due_date,
                    "barcode": "N/A",
                    "message": "Nenhuma mensalidade em aberto encontrada no portal."
                }
            
            # === Stage 7: Clicar em Pagar ===
            logger.info("Clicando no botão 'Pagar'...")
            btn_pagar = page.locator('text="Pagar"').last
            await btn_pagar.click()
            await page.wait_for_timeout(5000)
            
            await page.screenshot(path="tmp/unopar_03_pagar.png")
            
            # === Stage 8: Clicar em "Pix Copia e Cola" para copiar o codigo ===
            logger.info("Clicando em 'Pix Copia e Cola'...")
            pix_code = "Nao encontrado"
            
            try:
                pix_btn = page.locator('text="Pix Copia e Cola"').first
                await pix_btn.click(timeout=10000)
                await page.wait_for_timeout(3000)
                
                # O portal copia automaticamente o codigo PIX para a area de transferencia
                pix_code = await page.evaluate("navigator.clipboard.readText()")
                logger.info(f"PIX copiado do clipboard! Tamanho: {len(pix_code)} chars")
                
            except Exception as pix_err:
                logger.warning(f"Falha ao extrair PIX Copia e Cola: {str(pix_err)}")
                
            logger.info(f"PIX extraido! Tamanho: {len(pix_code)} chars")
            
            return {
                "status": "success",
                "description": f"{description} - {datetime.now().month:02d}/{datetime.now().year}",
                "amount": amount,
                "due_date": due_date,
                "barcode": pix_code,
                "message": "Mensalidade Unopar extraida com sucesso via Portal do Aluno."
            }

        except Exception as nav_err:
            logger.warning(f"Processo falhou na navegação: {str(nav_err)}")
            await page.screenshot(path="tmp/unopar_error_critico.png")
            return {"status": "error", "message": f"Erro ao navegar no PDA Unopar: {str(nav_err)}"}
            
        finally:
            await browser.close()

if __name__ == "__main__":
    resultado = asyncio.run(scrape_unopar())
    print("\n[Modulo de Scraping Unopar]:")
    print(resultado)
