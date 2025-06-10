const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises; // Usaremos fs.promises para todas as operações de arquivo
const ExcelJS = require('exceljs');
const moment = require('moment');
const Store = require('electron-store').default;

const store = new Store();

function createWindow() {
  const win = new BrowserWindow({
    width: 900,
    height: 700,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    }
  });

  win.loadFile('index.html');
}

// Caminho da pasta interna e do arquivo copiado
const userDataPath = app.getPath('userData');
const internalCsvPath = path.join(userDataPath, 'anterior.csv');


// -- FUNÇÕES DE LÓGICA --

// Garante que o arquivo CSV interno exista, se não, pede para selecionar e copia para a pasta interna
// ALTERADO: Não foi implementado no código original, mas é uma boa prática chamar isso na inicialização.
async function ensureInternalCSV() {
  try {
    await fsp.access(internalCsvPath, fs.constants.F_OK);
    // Arquivo já existe, tudo certo.
    return internalCsvPath;
  } catch (error) {
    // Arquivo não existe, vamos pedir ao usuário.
    const result = await dialog.showOpenDialog({
      title: 'Selecione o arquivo anterior.csv',
      filters: [{ name: 'CSV Files', extensions: ['csv'] }],
      properties: ['openFile']
    });

    if (result.canceled || result.filePaths.length === 0) {
      throw new Error('Nenhum arquivo CSV selecionado na configuração inicial.');
    }

    const selectedPath = result.filePaths[0];
    
    await fsp.mkdir(userDataPath, { recursive: true });
    await fsp.copyFile(selectedPath, internalCsvPath);
    store.set('anteriorCSVPath', internalCsvPath);

    return internalCsvPath;
  }
}

// Função para ler e parsear CSV, idêntica à sua original
function parseCSVtoRowsAdjusted(csvText) {
  const lines = csvText.trim().split('\n');
  const header = lines.shift().split(',');

  const headerMap = {
    'Date': 'Data',
    'N1': 'n1',
    'N2': 'n2',
    'N3': 'n3',
    'N4': 'n4',
    'N5': 'n5',
    'Cash Ball': 'cash ball'
  };

  const rows = lines.map(line => {
    const cols = line.split(',');
    const obj = {};

    header.forEach((h, i) => {
      const key = headerMap[h.trim()];
      if (!key) return;

      if (key === 'Data') {
        const parsedDate = moment(cols[i].trim(), 'MM/DD/YY', true);
        obj[key] = parsedDate.isValid() ? parsedDate.format('YYYY-MM-DD') : null;
      } else {
        obj[key] = cols[i].trim();
      }
    });

    return obj;
  }).filter(row => row.Data !== null);

  return rows;
}

// Obtém última data do CSV interno
// CORREÇÃO: Trocado para versão assíncrona para não bloquear a UI.
async function getLastDateFromCSV(csvPath) {
  try {
    const data = await fsp.readFile(csvPath, 'utf8');
    const rows = parseCSVtoRowsAdjusted(data);

    if (rows.length === 0){
      console.error('⚠️ Nenhuma linha válida encontrada no CSV!');
      return null;
    }

    const sorted = rows.sort((a, b) => (b.Data.localeCompare(a.Data)));
    console.log('✅ Última data encontrada no CSV:', sorted[0].Data);
    return sorted[0].Data;
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null; // Arquivo não existe, o que é um estado válido.
    }
    console.error('Erro ao obter última data do CSV:', error);
    return null;
  }
}

// -- HANDLERS DO IPCMAIN --

// Handler para exportar para Excel
// CORREÇÃO: Trocado para versão assíncrona para não bloquear a UI.
ipcMain.handle('export-to-excel', async (event, newRows) => {
  try {
    const csvPath = store.get('anteriorCSVPath') || internalCsvPath;
    if (!newRows || newRows.length === 0) throw new Error('Sem dados para exportar.');

    let previousRows = [];
    try {
      const csvData = await fsp.readFile(csvPath, 'utf8');
      previousRows = parseCSVtoRowsAdjusted(csvData);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.warn(`Aviso: não foi possível ler o arquivo CSV anterior. Continuando sem ele.`, error);
      }
      // Se o arquivo não existe, `previousRows` continua como [], o que está correto.
    }
    
    // O resto da sua lógica já era excelente, apenas mantida.
    const newRowsFormatted = newRows.map(({ data, numeros }) => {
      const parsedDate = moment(data.trim(), 'MM/DD/YYYY', true);
      const dataFormatada = parsedDate.isValid() ? parsedDate.format('YYYY-MM-DD') : null;
      if (!dataFormatada) return null;
      const nums = numeros.split(',').map(n => n.trim());
      return { Data: dataFormatada, n1: nums[0]||'', n2: nums[1]||'', n3: nums[2]||'', n4: nums[3]||'', n5: nums[4]||'', 'cash ball': nums[5]||'' };
    }).filter(row => row !== null);

    const allRows = [...previousRows, ...newRowsFormatted];
    const uniqueMap = new Map();
    allRows.forEach(row => { uniqueMap.set(row.Data, row); });
    const finalRows = Array.from(uniqueMap.values()).sort((a, b) => a.Data.localeCompare(b.Data));

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Resultados');
    sheet.columns = [
      { header: 'Data', key: 'Data', width: 15 }, { header: 'n1', key: 'n1', width: 8 }, { header: 'n2', key: 'n2', width: 8 },
      { header: 'n3', key: 'n3', width: 8 }, { header: 'n4', key: 'n4', width: 8 }, { header: 'n5', key: 'n5', width: 8 },
      { header: 'cash ball', key: 'cash ball', width: 10 },
    ];
    finalRows.forEach(row => { sheet.addRow({ ...row, Data: moment(row.Data, 'YYYY-MM-DD').format('DD/MM/YYYY') }); });

    const { canceled, filePath } = await dialog.showSaveDialog({
      title: 'Salvar planilha Excel', defaultPath: 'resultados.xlsx',
      filters: [{ name: 'Excel Files', extensions: ['xlsx'] }]
    });

    if (canceled || !filePath) return null;
    await workbook.xlsx.writeFile(filePath);
    return filePath;
  } catch (error) {
    console.error('Erro ao exportar Excel:', error);
    throw error;
  }
});

// Handler para seleção manual do CSV
ipcMain.handle('select-anterior-csv', async () => {
  const result = await dialog.showOpenDialog({
    title: 'Selecione o arquivo CSV',
    filters: [{ name: 'CSV Files', extensions: ['csv'] }],
    properties: ['openFile']
  });

  if (result.canceled || result.filePaths.length === 0) return null;

  const selectedPath = result.filePaths[0];
  try {
    await fsp.copyFile(selectedPath, internalCsvPath);
    console.log(`✅ Arquivo anterior.csv copiado para: ${internalCsvPath}`);
    store.set('anteriorCSVPath', internalCsvPath);
    return internalCsvPath;
  } catch (err) {
    console.error('Erro ao copiar arquivo selecionado:', err);
    return null;
  }
});

// Handler para atualizar o CSV interno com novas linhas
// CORREÇÃO CRÍTICA: Lógica de atualização, ordenação e formato de data corrigidos.
ipcMain.handle('update-anterior-csv', async (event, newRows) => {
  if (!newRows || newRows.length === 0) return null;

  try {
    let existingContent = '';
    try {
      existingContent = await fsp.readFile(internalCsvPath, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      // Se o arquivo não existe, `existingContent` fica vazio.
    }
    
    const existingLines = existingContent.trim().split('\n');
    const header = existingLines.length > 0 && existingLines[0].startsWith('Date') 
                   ? existingLines.shift() 
                   : 'Date,N1,N2,N3,N4,N5,Cash Ball';

    const dataLines = existingLines;

    // Padroniza as novas linhas para o formato CSV (MM/DD/YY)
    const formattedNewRows = newRows.map(row => {
      const parsedDate = moment(row.data, 'MM/DD/YYYY', true); // Assumindo que a data do scraper vem como MM/DD/YYYY
      if (!parsedDate.isValid()) return null;

      const formattedDate = parsedDate.format('MM/DD/YY');
      const [n1, n2, n3, n4, n5, cashBall] = row.numeros.split(',').map(s => s.trim());
      return `${formattedDate},${n1},${n2},${n3},${n4},${n5},${cashBall}`;
    }).filter(Boolean); // Filtra linhas nulas (datas inválidas)

    const allDataLines = [...dataLines, ...formattedNewRows];
    
    // Deduplica e ordena para garantir a integridade do arquivo
    const finalDataMap = new Map();
    allDataLines.forEach(line => {
      const dateKey = line.split(',')[0].trim();
      if(dateKey) finalDataMap.set(dateKey, line);
    });
    
    const sortedData = Array.from(finalDataMap.values()).sort((a, b) => {
        const dateA = moment(a.split(',')[0], 'MM/DD/YY');
        const dateB = moment(b.split(',')[0], 'MM/DD/YY');
        return dateA - dateB; // Ordena do mais antigo para o mais novo
    });

    // Escreve o arquivo final, sempre íntegro e ordenado
    await fsp.writeFile(internalCsvPath, [header, ...sortedData].join('\n'), 'utf8');
    console.log(`✅ Arquivo anterior.csv atualizado com dados ordenados em: ${internalCsvPath}`);
    return internalCsvPath;
  } catch (err) {
    console.error('Erro ao atualizar CSV interno:', err);
    return null;
  }
});

// Outros handlers simples
ipcMain.handle('get-anterior-csv-path', () => store.get('anteriorCSVPath') || null);
ipcMain.handle('get-last-date-from-csv', (event, csvPath) => getLastDateFromCSV(csvPath));
ipcMain.handle('open-folder', (event, filePath) => {
  if (filePath) shell.openPath(path.dirname(filePath)).catch(err => console.error('Erro ao abrir pasta:', err));
});

// -- INICIALIZAÇÃO DA APLICAÇÃO --

app.whenReady().then(async () => {
  try {
    await ensureInternalCSV(); // Garante que o CSV existe antes de criar a janela
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  } catch (err) {
    console.error('Erro na inicialização do app:', err.message);
    dialog.showErrorBox('Erro Crítico', `Ocorreu um erro na inicialização e o aplicativo será fechado. Detalhes: ${err.message}`);
    app.quit();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});