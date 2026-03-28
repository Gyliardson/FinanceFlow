import asyncio
import logging
from datetime import datetime, timedelta
from database import get_supabase_client
from unopar_scraper import scrape_unopar
from tim_scraper import scrape_tim
from dasmei_scraper import scrape_dasmei

logger = logging.getLogger(__name__)

SERVICES = [
    {
        "name": "Guia DAS MEI",
        "scraper_func": scrape_dasmei,
        "search_prefix": "Guia DAS MEI%"
    },
    {
        "name": "Mensalidade Unopar",
        "scraper_func": scrape_unopar,
        "search_prefix": "Mensalidade Unopar%"
    },
    {
        "name": "Conta TIM Movel",
        "scraper_func": scrape_tim,
        "search_prefix": "Conta TIM Movel%"
    }
]

async def start_scheduler():
    """
    Background task iniciada com o FastAPI para checar boletos.
    """
    logger.info("Scheduler de Scraping Iniciado. Loop de 24h configurado.")
    await asyncio.sleep(5) # Delay inicial
    
    while True:
        logger.info("Executando checagem diária do Scheduler de Boletos...")
        
        try:
            supabase = get_supabase_client()
            today = datetime.now().date()
            
            for service in SERVICES:
                logger.info(f"Analisando agendamento para: {service['name']}")
                
                # Buscar a última fatura desse serviço
                response = supabase.table("finance_bills")\
                    .select("*")\
                    .ilike("description", service["search_prefix"])\
                    .order("due_date", desc=True)\
                    .limit(1)\
                    .execute()
                
                should_scrape = False
                
                if not response.data:
                    logger.info(f"[{service['name']}] Nenhuma fatura anterior encontrada. Iniciando primeira busca.")
                    should_scrape = True
                else:
                    last_bill = response.data[0]
                    last_due_date_str = last_bill.get("due_date")
                    if last_due_date_str:
                        # Assumindo formato YYYY-MM-DD
                        last_due_date = datetime.strptime(last_due_date_str, "%Y-%m-%d").date()
                        
                        if last_due_date >= today:
                            logger.info(f"[{service['name']}] Fatura pendente (Venc: {last_due_date}) já está no sistema. Pulando.")
                        else:
                            # Próxima fatura esperada para aprox. 30 dias após a última
                            expected_next_due = last_due_date + timedelta(days=30)
                            fetch_start_date = expected_next_due - timedelta(days=15)
                            
                            if today >= fetch_start_date:
                                logger.info(f"[{service['name']}] Estamos a <= 15 dias do vencimento estimado ({expected_next_due}). Iniciando busca.")
                                should_scrape = True
                            else:
                                logger.info(f"[{service['name']}] Muito cedo para buscar a próxima fatura (Gatilho em: {fetch_start_date}). Pulando.")
                    else:
                        logger.warning(f"[{service['name']}] Fatura antiga sem data de vencimento válida. Iniciando busca fallback.")
                        should_scrape = True

                if should_scrape:
                    try:
                        logger.info(f"[{service['name']}] Disparando Scraper...")
                        resultado = await service["scraper_func"]()
                        
                        # Inserir no banco se achou algo contendo vencimento válido e amount > 0 ou status não info 
                        # Muitos scrapers retornam info se já está pago, ou se o amount=0
                        if resultado.get("status") == "success" and resultado.get("amount", 0) > 0:
                            data = {
                                "description": resultado.get("description"),
                                "amount": resultado.get("amount"),
                                "due_date": resultado.get("due_date"),
                                "barcode": resultado.get("barcode"),
                                "status": "pending"
                            }
                            # Check para garantir duplicidade exata caso o schedule dispare ao msm tempo da API
                            existing = supabase.table("finance_bills").select("id").eq("description", data["description"]).execute()
                            if not existing.data:
                                supabase.table("finance_bills").insert(data).execute()
                                logger.info(f"[{service['name']}] Nova fatura extraida e inserida no Supabase via Scheduler.")
                            else:
                                logger.info(f"[{service['name']}] A fatura extraída já havia sido inserida por outra origem. Ignorando inclusão.")
                        elif resultado.get("status") == "info":
                            logger.info(f"[{service['name']}] Scraper executou mas as contas já estão pagas/não há guias: {resultado.get('message')}")
                        else:
                            logger.error(f"[{service['name']}] Scraper falhou ou retornou sem dados inseriveis: {resultado}")
                            
                    except Exception as scrape_err:
                        logger.error(f"Erro ao executar scraper iterativo {service['name']}: {scrape_err}")
                
                await asyncio.sleep(10) # 10s delay entre cada servico para evitar sobrecarga no servidor / CPU / RAM

        except Exception as e:
            logger.error(f"Erro crítico no loop do Scheduler: {e}")
            
        logger.info("Ciclo do Scheduler finalizado. Aguardando 24 horas.")
        await asyncio.sleep(86400) # 24 horas em segundos
