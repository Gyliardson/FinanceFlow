import os
import imaplib
import email
from email.header import decode_header
import logging
import io
from dotenv import load_dotenv
from pypdf import PdfReader, PdfWriter
from ai_service import extract_invoice_data
from database import get_supabase_client

load_dotenv()

logger = logging.getLogger(__name__)

IMAP_SERVER = "imap.gmail.com"
EMAIL_ACCOUNT = os.getenv("GMAIL_EMAIL") or os.getenv("IMAP_EMAIL")
EMAIL_PASSWORD = (os.getenv("GMAIL_APP_PASSWORD") or os.getenv("IMAP_PASSWORD", "")).replace(" ", "")
TARGET_CNPJ = os.getenv("TARGET_CNPJ", "")

def decrypt_pdf(encrypted_bytes: bytes, password: str) -> bytes:
    """
    Remove a senha do PDF usando os 4 primeiros dígitos do CNPJ
    """
    reader = PdfReader(io.BytesIO(encrypted_bytes))
    
    if not reader.is_encrypted:
         return encrypted_bytes
         
    # Tenta descriptografar usando a senha fornecida
    decrypted = reader.decrypt(password)
    if not decrypted:
        raise ValueError("Falha ao descriptografar o PDF. Senha incorreta.")
        
    writer = PdfWriter()
    for page in reader.pages:
        writer.add_page(page)
        
    output = io.BytesIO()
    writer.write(output)
    return output.getvalue()

def decode_mime_words(s):
    if not s:
        return ""
    decoded_string = ""
    for word, encoding in decode_header(s):
        if isinstance(word, bytes):
            decoded_string += word.decode(encoding if encoding else "utf-8", errors="ignore")
        else:
            decoded_string += word
    return decoded_string

async def scrape_vivo_email():
    """
    Conecta ao servidor IMAP, busca por e-mails não lidos contendo PDF,
    descriptografa (se tiver configurada a senha baseada no CNPJ), 
    processa no Gemini e salva no banco.
    """
    if not EMAIL_ACCOUNT or not EMAIL_PASSWORD:
        return {
            "status": "error",
            "message": "Credenciais OUTLOOK_EMAIL ou OUTLOOK_PASSWORD ausentes no .env"
        }

    try:
        # 1. Conexão e Login IMAP
        mail = imaplib.IMAP4_SSL(IMAP_SERVER)
        mail.login(EMAIL_ACCOUNT, EMAIL_PASSWORD)
        mail.select("inbox")

        # 2. Busca e-mails não lidos (pode ser ajustado para FROM specific se desejar)
        status, messages = mail.search(None, "UNSEEN")
        if status != "OK" or not messages[0]:
            mail.logout()
            return {"status": "info", "message": "Nenhum e-mail não lido encontrado."}

        email_ids = messages[0].split()
        processed_bills = []
        supabase = get_supabase_client()
        password_pdf = TARGET_CNPJ[:4] if TARGET_CNPJ else ""

        # 3. Itera sobre os e-mails
        for e_id in email_ids:
            res, msg_data = mail.fetch(e_id, "(RFC822)")
            if res != "OK":
                continue

            for response_part in msg_data:
                if isinstance(response_part, tuple):
                    msg = email.message_from_bytes(response_part[1])
                    subject = decode_mime_words(msg.get("Subject"))
                    
                    found_pdf = False
                    
                    for part in msg.walk():
                        if part.get_content_maintype() == "multipart":
                            continue
                        if part.get("Content-Disposition") is None:
                            continue
                            
                        filename = part.get_filename()
                        if filename:
                            filename = decode_mime_words(filename)
                            if filename.lower().endswith(".pdf"):
                                # 4. Baixa o PDF
                                encrypted_pdf_bytes = part.get_payload(decode=True)
                                
                                try:
                                    # 5. Descriptografa com 4 primeiros digitos do CNPJ
                                    pdf_bytes = decrypt_pdf(encrypted_pdf_bytes, password_pdf) if password_pdf else encrypted_pdf_bytes
                                except Exception as dec_err:
                                    logger.error(f"Erro ao descriptografar PDF {filename}: {dec_err}")
                                    continue # Pula se falhou a senha

                                # 6. Envia para o Gemini Extrair
                                ocr_result = extract_invoice_data(pdf_bytes, mime_type="application/pdf")
                                
                                if ocr_result.get("status") == "success":
                                    ext_data = ocr_result.get("extracted_data", {})
                                    
                                    # 7. Salva no banco "finance_bills"
                                    amount = ext_data.get("amount")
                                    due_date = ext_data.get("due_date")
                                    barcode = ext_data.get("barcode")
                                    
                                    if amount is not None and due_date:
                                        db_data = {
                                            "description": f"Fatura Vivo Fixo (E-mail) - {subject}",
                                            "amount": amount,
                                            "due_date": due_date,
                                            "barcode": barcode,
                                            "status": "pending"
                                        }
                                        db_response = supabase.table("finance_bills").insert(db_data).execute()
                                        processed_bills.append(db_response.data[0] if db_response.data else db_data)
                                        found_pdf = True
                                        
                    # Marca como lido apenas se processou um PDF válido
                    # Porém o fetch original de RFC822 já marca como lido (SEEN) automaticamente em muitos provedores.
                    # Se não houvesse PDF, o ideal seria re-marcar como UNSEEN, ou apenas aceitar.
        mail.logout()
        
        message = f"Processados {len(processed_bills)} boletos com sucesso." if processed_bills else "Nenhum boleto em anexo suportado encontrado nos e-mails novos."
        return {
            "status": "success",
            "message": message,
            "data": processed_bills
        }

    except Exception as e:
        logger.error(f"Erro no IMAP Scraper: {str(e)}")
        return {"status": "error", "message": f"Erro interno ao buscar e-mails: {str(e)}"}
