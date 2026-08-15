import React, { useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import DateTimePicker from '@react-native-community/datetimepicker';
import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import api from '../services/api';
import { buildOcrUploadFile, OcrUploadKind } from '../services/ocrUploadFile';
import { useFinancialMutation } from '../services/useFinancialMutation';

const MAX_CLIENT_UPLOAD_BYTES = 10 * 1024 * 1024;

const normalizeCurrencyInput = (value: string) => {
  const digits = value.replace(/[^0-9]/g, '');
  if (!digits) return '';
  return Math.min(Number(digits) / 100, 1_000_000).toFixed(2).replace('.', ',');
};

const normalizeDateInput = (value: string) => {
  const digits = value.replace(/[^0-9]/g, '').slice(0, 8);
  if (digits.length <= 2) return digits;
  if (digits.length <= 4) return `${digits.slice(0, 2)}/${digits.slice(2)}`;
  return `${digits.slice(0, 2)}/${digits.slice(2, 4)}/${digits.slice(4)}`;
};

const toDatabaseDate = (value: string) => {
  if (!/^\d{2}\/\d{2}\/\d{4}$/.test(value)) return null;
  const [dayText, monthText, yearText] = value.split('/');
  const day = Number(dayText);
  const month = Number(monthText);
  const year = Number(yearText);
  const currentYear = new Date().getFullYear();
  if (year < 2000 || year > currentYear + 5 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const candidate = new Date(year, month - 1, day);
  if (candidate.getFullYear() !== year || candidate.getMonth() !== month - 1 || candidate.getDate() !== day) return null;
  return `${yearText}-${monthText}-${dayText}`;
};

export default function DetailScreen({ navigation }: any) {
  const [isManual, setIsManual] = useState(false);
  const [loadingOCR, setLoadingOCR] = useState(false);
  const [loadingSave, setLoadingSave] = useState(false);
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [barcode, setBarcode] = useState('');
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [dateObj, setDateObj] = useState(new Date());
  const billMutation = useFinancialMutation('/add-bill');

  const busy = loadingOCR || loadingSave;
  const intentLocked = billMutation.hasActiveIntent;
  const editable = !busy && !intentLocked;

  const validateClientFile = (asset: any) => {
    if (typeof asset?.size === 'number' && asset.size > MAX_CLIENT_UPLOAD_BYTES) {
      Alert.alert('Arquivo muito grande', 'Selecione um arquivo de até 10 MB.');
      return false;
    }
    return true;
  };

  const handlePickDocument = async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: 'application/pdf',
        multiple: false,
        copyToCacheDirectory: true,
      });
      const asset = !result.canceled ? result.assets?.[0] : null;
      if (asset && validateClientFile(asset)) await uploadForOCR(asset, 'pdf');
    } catch {
      Alert.alert('Não foi possível abrir o documento', 'Tente novamente ou preencha os dados manualmente.');
    }
  };

  const handlePickImage = async () => {
    try {
      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!permission.granted) {
        Alert.alert('Permissão necessária', 'Autorize o acesso à galeria para selecionar uma imagem.');
        return;
      }
      const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.8 });
      const asset = !result.canceled ? result.assets?.[0] : null;
      if (asset && validateClientFile(asset)) await uploadForOCR(asset, 'image');
    } catch {
      Alert.alert('Não foi possível abrir a galeria', 'Tente novamente ou preencha os dados manualmente.');
    }
  };

  const uploadForOCR = async (fileAsset: any, kind: OcrUploadKind) => {
    if (loadingOCR || intentLocked) return;
    const uploadFile = buildOcrUploadFile(fileAsset, kind);
    if (!uploadFile) {
      Alert.alert(
        'Formato não identificado',
        'Selecione uma imagem JPEG, PNG ou WebP com formato reconhecível, ou use um documento PDF.',
      );
      return;
    }

    setLoadingOCR(true);
    try {
      const formData = new FormData();
      formData.append('file', uploadFile as any);
      const response = await api.post('/upload-receipt', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
        timeout: 30000,
      });
      const ocrData = response.data?.ocr_result;
      if (!ocrData) {
        Alert.alert('Leitura incompleta', 'A IA não retornou campos utilizáveis. Revise e preencha os dados manualmente.');
        return;
      }
      if (ocrData.amount !== undefined && ocrData.amount !== null) {
        const numericAmount = Number(ocrData.amount);
        if (Number.isFinite(numericAmount) && numericAmount >= 0) setAmount(numericAmount.toFixed(2).replace('.', ','));
      }
      if (typeof ocrData.due_date === 'string') {
        const parts = ocrData.due_date.split('-');
        if (parts.length === 3) {
          const [yearText, monthText, dayText] = parts;
          const candidate = `${dayText}/${monthText}/${yearText}`;
          if (toDatabaseDate(candidate)) {
            setDueDate(candidate);
            setDateObj(new Date(Number(yearText), Number(monthText) - 1, Number(dayText)));
          }
        }
      }
      if (typeof ocrData.barcode === 'string') setBarcode(ocrData.barcode);
      if (!description) setDescription(`Fatura ${fileAsset.name || fileAsset.fileName || 'digitalizada'}`);
      Alert.alert('Leitura concluída', 'Revise os campos extraídos antes de salvar a fatura.');
    } catch (error: any) {
      Alert.alert(
        'Leitura indisponível',
        error?.response?.status === 429
          ? 'O serviço de leitura está temporariamente ocupado. Tente novamente mais tarde ou preencha manualmente.'
          : 'Não foi possível extrair os dados. Revise o arquivo ou preencha os campos manualmente.'
      );
    } finally {
      setLoadingOCR(false);
    }
  };

  const handleSaveBill = async () => {
    if (busy) return;
    const trimmedDescription = description.trim();
    if (!amount || !trimmedDescription || !dueDate) {
      Alert.alert('Campos obrigatórios', 'Informe descrição, valor e data de vencimento.');
      return;
    }
    const cleanAmount = Number(amount.replace(',', '.'));
    if (!Number.isFinite(cleanAmount) || cleanAmount <= 0) {
      Alert.alert('Valor inválido', 'Informe um valor maior que zero.');
      return;
    }
    const dbDate = toDatabaseDate(dueDate);
    if (!dbDate) {
      Alert.alert('Data inválida', 'Informe uma data real no formato DD/MM/AAAA, entre 2000 e até 5 anos no futuro.');
      return;
    }

    setLoadingSave(true);
    try {
      await billMutation.mutate({
        description: trimmedDescription,
        amount: cleanAmount,
        due_date: dbDate,
        barcode: barcode.trim() || null,
        status: 'pending',
      });
      Alert.alert('Fatura adicionada', 'A fatura foi salva com sucesso.');
      navigation.goBack();
    } catch {
      Alert.alert(
        'Resultado ainda não confirmado',
        'Os valores desta intenção foram bloqueados. Tente salvar novamente para reutilizar a mesma identidade e o payload original; sair desta tela e iniciar outro cadastro cria uma nova intenção.'
      );
    } finally {
      setLoadingSave(false);
    }
  };

  return (
    <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={styles.header}>
          <Text accessibilityRole="header" style={styles.title}>{isManual ? 'Nova fatura manual' : 'Nova fatura por documento'}</Text>
          <Text style={styles.subtitle}>{isManual ? 'Preencha os dados da despesa. Você poderá revisar tudo antes de salvar.' : 'Use uma imagem ou PDF para sugerir campos por IA e revise o resultado antes de salvar.'}</Text>
          <View style={styles.modeRow}>
            <View style={styles.modeCopy}><Text style={styles.modeTitle}>Preenchimento manual</Text><Text style={styles.modeHint}>{isManual ? 'Ativado' : 'Desativado — usando leitura de documento'}</Text></View>
            <Switch value={isManual} onValueChange={setIsManual} disabled={!editable} accessibilityLabel="Usar preenchimento manual" accessibilityHint="Alterna entre leitura por documento e preenchimento manual" accessibilityState={{ checked: isManual, disabled: !editable }} />
          </View>
        </View>

        {intentLocked && <Text style={styles.intentNotice}>Resultado anterior indeterminado: os campos estão bloqueados para que o retry repita exatamente a mesma intenção.</Text>}

        {!isManual && (
          <View style={styles.ocrBox}>
            <Text style={styles.sectionTitle}>Importar documento</Text>
            <Text style={styles.sectionHint}>Aceita imagem da galeria ou PDF de até 10 MB.</Text>
            {loadingOCR ? (
              <View style={styles.loadingBox} accessibilityLiveRegion="polite"><ActivityIndicator size="large" color="#4f46e5" /><Text style={styles.loadingText}>Analisando o documento…</Text></View>
            ) : (
              <View style={styles.buttonRow}>
                <TouchableOpacity disabled={!editable} style={styles.secondaryButton} onPress={handlePickImage} accessibilityRole="button" accessibilityLabel="Selecionar imagem da galeria"><Text style={styles.secondaryButtonText}>Imagem</Text></TouchableOpacity>
                <TouchableOpacity disabled={!editable} style={styles.secondaryButton} onPress={handlePickDocument} accessibilityRole="button" accessibilityLabel="Selecionar documento PDF"><Text style={styles.secondaryButtonText}>PDF</Text></TouchableOpacity>
              </View>
            )}
          </View>
        )}

        <View style={styles.form}>
          <Text style={styles.sectionTitle}>Dados da fatura</Text>
          <Text style={styles.inputLabel}>Descrição *</Text>
          <TextInput style={styles.input} value={description} onChangeText={setDescription} editable={editable} placeholder="Ex.: Plano de internet" maxLength={150} accessibilityLabel="Descrição da fatura" />
          <Text style={styles.inputLabel}>Valor *</Text>
          <View style={styles.currencyInput}><Text style={styles.currencyPrefix}>R$</Text><TextInput style={styles.currencyField} keyboardType="decimal-pad" value={amount} onChangeText={(text) => setAmount(normalizeCurrencyInput(text))} editable={editable} placeholder="0,00" accessibilityLabel="Valor da fatura em reais" /></View>
          <Text style={styles.inputLabel}>Data de vencimento *</Text>
          {Platform.OS === 'web' ? (
            <TextInput style={styles.input} value={dueDate} onChangeText={(text) => setDueDate(normalizeDateInput(text))} editable={editable} placeholder="DD/MM/AAAA" keyboardType="numeric" maxLength={10} accessibilityLabel="Data de vencimento no formato dia mês ano" />
          ) : (
            <TouchableOpacity style={styles.dateButton} onPress={() => setShowDatePicker(true)} disabled={!editable} accessibilityRole="button" accessibilityLabel={dueDate ? `Data de vencimento ${dueDate}` : 'Selecionar data de vencimento'} accessibilityHint="Abre o seletor de data"><Text style={[styles.dateButtonText, !dueDate && styles.placeholderText]}>{dueDate || 'Selecionar data'}</Text></TouchableOpacity>
          )}
          {showDatePicker && Platform.OS !== 'web' && (
            <DateTimePicker value={dateObj} mode="date" display="default" maximumDate={new Date(new Date().getFullYear() + 5, 11, 31)} minimumDate={new Date(2000, 0, 1)} onChange={(_, selectedDate) => {
              setShowDatePicker(Platform.OS === 'ios');
              if (!selectedDate) return;
              setDateObj(selectedDate);
              const day = String(selectedDate.getDate()).padStart(2, '0');
              const month = String(selectedDate.getMonth() + 1).padStart(2, '0');
              setDueDate(`${day}/${month}/${selectedDate.getFullYear()}`);
            }} />
          )}
          <Text style={styles.inputLabel}>Linha digitável ou chave Pix</Text>
          <TextInput style={[styles.input, styles.multilineInput]} multiline value={barcode} onChangeText={setBarcode} editable={editable} placeholder="Opcional" maxLength={255} accessibilityLabel="Linha digitável ou chave Pix opcional" accessibilityHint="Revise este campo especialmente quando preenchido por IA" />
          <Text style={styles.reviewNotice}>Revise valor, vencimento e linha digitável antes de confirmar.</Text>
          <TouchableOpacity style={[styles.saveButton, busy && styles.buttonDisabled]} onPress={handleSaveBill} disabled={busy} accessibilityRole="button" accessibilityLabel="Salvar nova fatura" accessibilityHint={intentLocked ? 'Repete a mesma intenção financeira com a identidade e os valores originais' : 'Salva a fatura informada'} accessibilityState={{ disabled: busy, busy: loadingSave }}>
            {loadingSave ? <ActivityIndicator color="#fff" /> : <Text style={styles.saveButtonText}>{intentLocked ? 'Tentar mesma intenção' : 'Salvar fatura'}</Text>}
          </TouchableOpacity>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f1f5f9' }, content: { paddingBottom: 48 },
  header: { paddingHorizontal: 20, paddingTop: 28, paddingBottom: 20, backgroundColor: '#fff', borderBottomLeftRadius: 20, borderBottomRightRadius: 20 },
  title: { fontSize: 25, lineHeight: 31, fontWeight: '900', color: '#0f172a' }, subtitle: { marginTop: 8, fontSize: 14, lineHeight: 21, color: '#475569' },
  modeRow: { minHeight: 56, marginTop: 18, paddingHorizontal: 14, paddingVertical: 10, borderRadius: 12, backgroundColor: '#f8fafc', flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }, modeCopy: { flex: 1 }, modeTitle: { fontSize: 14, fontWeight: '800', color: '#1e293b' }, modeHint: { marginTop: 2, fontSize: 12, lineHeight: 17, color: '#64748b' },
  intentNotice: { margin: 16, padding: 12, borderRadius: 10, backgroundColor: '#fffbeb', color: '#92400e', fontSize: 12, lineHeight: 18, fontWeight: '700' },
  ocrBox: { marginHorizontal: 16, marginTop: 16, padding: 16, backgroundColor: '#eef2ff', borderRadius: 16, borderWidth: 1, borderColor: '#c7d2fe' }, sectionTitle: { fontSize: 17, lineHeight: 23, fontWeight: '900', color: '#1e293b' }, sectionHint: { marginTop: 4, fontSize: 12, lineHeight: 18, color: '#475569' }, loadingBox: { minHeight: 96, alignItems: 'center', justifyContent: 'center' }, loadingText: { marginTop: 10, color: '#4338ca', fontWeight: '700' }, buttonRow: { flexDirection: 'row', gap: 10, marginTop: 14 }, secondaryButton: { flex: 1, minHeight: 48, borderRadius: 12, backgroundColor: '#4338ca', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 12 }, secondaryButtonText: { color: '#fff', fontWeight: '800', fontSize: 14 },
  form: { marginHorizontal: 16, marginTop: 16, padding: 18, backgroundColor: '#fff', borderRadius: 16 }, inputLabel: { marginTop: 18, marginBottom: 7, fontSize: 13, lineHeight: 18, color: '#334155', fontWeight: '800' }, input: { minHeight: 52, backgroundColor: '#f8fafc', borderRadius: 10, paddingHorizontal: 14, paddingVertical: 12, fontSize: 16, color: '#0f172a', borderWidth: 1, borderColor: '#cbd5e1' }, currencyInput: { minHeight: 52, flexDirection: 'row', alignItems: 'center', backgroundColor: '#f8fafc', borderRadius: 10, borderWidth: 1, borderColor: '#cbd5e1', paddingLeft: 14 }, currencyPrefix: { fontSize: 16, fontWeight: '800', color: '#475569', marginRight: 4 }, currencyField: { flex: 1, minHeight: 50, paddingHorizontal: 8, fontSize: 16, color: '#0f172a' }, dateButton: { minHeight: 52, justifyContent: 'center', backgroundColor: '#f8fafc', borderRadius: 10, paddingHorizontal: 14, borderWidth: 1, borderColor: '#cbd5e1' }, dateButtonText: { fontSize: 16, color: '#0f172a' }, placeholderText: { color: '#64748b' }, multilineInput: { minHeight: 92, textAlignVertical: 'top' }, reviewNotice: { marginTop: 16, padding: 12, borderRadius: 10, backgroundColor: '#fffbeb', color: '#92400e', fontSize: 12, lineHeight: 18, fontWeight: '700' }, saveButton: { minHeight: 52, marginTop: 20, borderRadius: 12, backgroundColor: '#4338ca', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16 }, saveButtonText: { color: '#fff', fontSize: 16, fontWeight: '900' }, buttonDisabled: { opacity: 0.6 },
});
