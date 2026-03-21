import React, { useState } from 'react';
import { View, Text, StyleSheet, TextInput, TouchableOpacity, Switch, ActivityIndicator, Alert, ScrollView } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import api from '../services/api';

export default function DetailScreen({ navigation }: any) {
  const [isManual, setIsManual] = useState(false);
  const [loadingOCR, setLoadingOCR] = useState(false);
  const [loadingSave, setLoadingSave] = useState(false);

  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [barcode, setBarcode] = useState('');

  const handleAmountChange = (text: string) => {
    const numericValue = text.replace(/[^0-9]/g, '');
    if (numericValue) {
      const val = (Number(numericValue) / 100).toFixed(2);
      setAmount(val.replace('.', ','));
    } else {
      setAmount('');
    }
  };

  const handleDateChange = (text: string) => {
    let numericValue = text.replace(/[^0-9]/g, '');
    if (numericValue.length > 8) numericValue = numericValue.substring(0, 8);
    let formatted = numericValue;
    if (numericValue.length > 2) {
      formatted = `${numericValue.substring(0, 2)}/${numericValue.substring(2)}`;
    }
    if (numericValue.length > 4) {
      formatted = `${numericValue.substring(0, 2)}/${numericValue.substring(2, 4)}/${numericValue.substring(4)}`;
    }
    setDueDate(formatted);
  };

  const handlePickDocument = async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({ type: '*/*' });
      if (!result.canceled && result.assets && result.assets.length > 0) {
        uploadForOCR(result.assets[0]);
      }
    } catch (err) {
      console.error(err);
    }
  };

  const handlePickImage = async () => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      return Alert.alert('Aviso', 'Autorize a galeria para o OCR funcionar!');
    }
    
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      quality: 0.8,
    });
    
    if (!result.canceled && result.assets && result.assets.length > 0) {
      uploadForOCR(result.assets[0]);
    }
  };

  const uploadForOCR = async (fileAsset: any) => {
    setLoadingOCR(true);
    try {
      const formData = new FormData();
      formData.append('file', {
        uri: fileAsset.uri,
        name: fileAsset.name || fileAsset.fileName || 'arquivo_comprovante.jpg',
        type: fileAsset.mimeType || 'image/jpeg'
      } as any);

      const response = await api.post('/upload-receipt', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
        timeout: 30000 
      });

      const ocrData = response.data.ocr_result;
      if (ocrData) {
        if (ocrData.amount) setAmount(Number(ocrData.amount).toFixed(2).replace('.', ','));
        if (ocrData.due_date) {
            const parts = ocrData.due_date.split('-');
            if (parts.length === 3) setDueDate(`${parts[2]}/${parts[1]}/${parts[0]}`);
            else setDueDate(ocrData.due_date);
        }
        setBarcode(ocrData.barcode || '');
        setDescription('Fatura ' + (fileAsset.name || 'Nova'));
        Alert.alert('Sucesso!', 'A Inteligência processou esse comprovante.');
      }
    } catch (error: any) {
      console.error(error);
      Alert.alert('Falha', 'Não foi possível extrair dados usando a Inteligência do Servidor.');
    } finally {
      setLoadingOCR(false);
    }
  };

  const handleSaveBill = async () => {
    if (!amount || !description) {
      Alert.alert('Incompleto', 'Os campos de Descrição e Valor são obrigatórios.');
      return;
    }
    
    const cleanAmount = parseFloat(amount.replace(',', '.'));
    if (isNaN(cleanAmount) || cleanAmount <= 0) {
      Alert.alert('Valor inválido', 'Digite um valor numérico correto (ex: 154,90).');
      return;
    }

    let dbDate = null;
    if (dueDate.length === 10) {
      const parts = dueDate.split('/');
      dbDate = `${parts[2]}-${parts[1]}-${parts[0]}`;
    } else if (dueDate.length > 0) {
      Alert.alert('Data inválida', 'A data deve estar no formato DD/MM/AAAA');
      return;
    }

    setLoadingSave(true);
    try {
      const payload = {
        description: description,
        amount: cleanAmount,
        due_date: dbDate,
        barcode: barcode ? barcode : null,
        status: 'pending'
      };
      
      await api.post('/add-bill', payload);
      Alert.alert('Armazenado!', 'Boleto cadastrado e sincronizado com o servidor principal.');
      navigation.goBack();
    } catch (error: any) {
      console.log("Erro Add-Bill:", error?.response?.data || error.message);
      Alert.alert('Erro fatal', 'O Banco de Dados recusou a tentativa de salvamento.');
    } finally {
      setLoadingSave(false);
    }
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={{ paddingBottom: 40 }}>
      <View style={styles.header}>
        <Text style={styles.title}>{isManual ? 'Despesa Avulsa/Recorrente' : 'Escanear Fatura'}</Text>
        <View style={styles.switchRow}>
          <Text style={styles.switchLabel}>Via Arquivo (IA)</Text>
          <Switch value={isManual} onValueChange={setIsManual} trackColor={{ true: '#2ecc71', false: '#bdc3c7' }} thumbColor="#fff" />
          <Text style={styles.switchLabel}>100% Manual</Text>
        </View>
        <Text style={styles.tipText}>
          {isManual ? 'Use para contas orgânicas como ajuda familiar e débitos fijos.' : 'Deixe o Gemini extrair os dados do seu PDF pra você.'}
        </Text>
      </View>

      {!isManual && (
        <View style={styles.ocrBox}>
          {loadingOCR ? (
            <View style={styles.loadingBox}>
              <ActivityIndicator size="large" color="#3498db" />
              <Text style={styles.loadingText}>Gemini está lendo e filtrando...</Text>
            </View>
          ) : (
             <View style={styles.buttonRow}>
               <TouchableOpacity style={styles.ocrButton} onPress={handlePickImage}>
                 <Text style={styles.ocrButtonText}>Galeria Imagens</Text>
               </TouchableOpacity>
               <TouchableOpacity style={[styles.ocrButton, { backgroundColor: '#e67e22' }]} onPress={handlePickDocument}>
                 <Text style={styles.ocrButtonText}>Buscar em PDF</Text>
               </TouchableOpacity>
             </View>
          )}
        </View>
      )}

      <View style={styles.form}>
        <Text style={styles.inputLabel}>Nome ou Descrição Mnemônica da Despesa*</Text>
        <TextInput style={styles.input} value={description} onChangeText={setDescription} placeholder="Ex: Gasto com IPTU ou Plano TIM" />

        <Text style={styles.inputLabel}>Custo real (R$)*</Text>
        <TextInput style={styles.input} keyboardType="numeric" value={amount} onChangeText={handleAmountChange} placeholder="0,00" />

        <Text style={styles.inputLabel}>Data de Pagamento (DD/MM/AAAA)</Text>
        <TextInput style={styles.input} keyboardType="numeric" value={dueDate} onChangeText={handleDateChange} placeholder="Ex: 10/05/2026" maxLength={10} />

        <Text style={styles.inputLabel}>Sequência Numérica ou chave Pix</Text>
        <TextInput style={[styles.input, { height: 90, textAlignVertical: 'top' }]} multiline value={barcode} onChangeText={setBarcode} placeholder="Números ou linha digitável" />

        <TouchableOpacity style={styles.saveButton} onPress={handleSaveBill} disabled={loadingSave || loadingOCR}>
          {loadingSave ? <ActivityIndicator color="#fff" /> : <Text style={styles.saveButtonText}>Adicionar Oficialmente</Text>}
        </TouchableOpacity>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f8f9fa' },
  header: { padding: 25, backgroundColor: '#fff', elevation: 2, marginBottom: 15, borderBottomLeftRadius: 20, borderBottomRightRadius: 20 },
  title: { fontSize: 26, fontWeight: '800', color: '#2c3e50', marginBottom: 15 },
  switchRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 8 },
  switchLabel: { fontSize: 13, color: '#34495e', marginHorizontal: 8, fontWeight: '600' },
  tipText: { fontSize: 12, color: '#7f8c8d' },
  ocrBox: { padding: 20, marginHorizontal: 20, backgroundColor: '#e8f4f8', borderRadius: 15, marginBottom: 15, borderWidth: 1, borderColor: '#d1e8ef' },
  buttonRow: { flexDirection: 'row', justifyContent: 'space-between' },
  ocrButton: { flex: 0.48, backgroundColor: '#3498db', paddingVertical: 14, borderRadius: 10, alignItems: 'center', elevation: 2 },
  ocrButtonText: { color: '#fff', fontWeight: 'bold', fontSize: 13 },
  loadingBox: { alignItems: 'center', padding: 10 },
  loadingText: { marginTop: 15, color: '#3498db', fontWeight: '700' },
  form: { padding: 20, backgroundColor: '#fff', marginHorizontal: 20, borderRadius: 15, elevation: 4, shadowColor: '#000', shadowOpacity: 0.1, shadowRadius: 5, shadowOffset: { width: 0, height: 2 }, marginBottom: 30 },
  inputLabel: { fontSize: 13, color: '#34495e', fontWeight: 'bold', marginBottom: 8 },
  input: { backgroundColor: '#f1f2f6', borderRadius: 10, paddingHorizontal: 15, paddingVertical: 14, marginBottom: 20, fontSize: 16, color: '#2c3e50', borderWidth: 1, borderColor: '#dcdde1' },
  saveButton: { backgroundColor: '#2ecc71', paddingVertical: 16, borderRadius: 10, alignItems: 'center', marginTop: 10, elevation: 3 },
  saveButtonText: { color: '#fff', fontSize: 16, fontWeight: '900' }
});
