"""Simula uma planilha "da equipe": acrescenta coluna própria, reordena, duplica linha e remove abas geradas."""
import sys
import openpyxl

src, dst = sys.argv[1], sys.argv[2]
wb = openpyxl.load_workbook(src)
for nome in ("Auditoria", "Log", "Resumo"):
    if nome in wb.sheetnames:
        del wb[nome]
ws = wb["Atribuídas"]
# coluna própria da equipe na posição 2
ws.insert_cols(2)
ws.cell(row=1, column=2, value="Observação da equipe")
for r in range(2, ws.max_row + 1):
    ws.cell(row=r, column=2, value=f"nota manual {r}")
# linha duplicada (mesmo número da linha 2) com nota diferente
ultima = ws.max_row + 1
for c in range(1, ws.max_column + 1):
    ws.cell(row=ultima, column=c, value=ws.cell(row=2, column=c).value)
ws.cell(row=ultima, column=2, value="nota duplicada")
# linha antiga que não está mais nas caixas
ws.cell(row=ultima + 1, column=1, value=36000001)
ws.cell(row=ultima + 1, column=2, value="caso antigo")
# aba extra da equipe
extra = wb.create_sheet("Controle interno")
extra["A1"] = "Planilha da equipe"; extra["A2"] = 123; extra["B2"] = "=A2*2"
wb.save(dst)
print("base modificada:", ws.max_row, "linhas em Atribuídas")
