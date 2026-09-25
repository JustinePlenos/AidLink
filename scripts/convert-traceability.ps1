$ErrorActionPreference = 'Stop'
$sourceOutput = Join-Path (Split-Path -Parent $PSScriptRoot) 'docs\outputs\AidLink_Requirements_Traceability_Status.docx'
$output = Join-Path (Split-Path -Parent $PSScriptRoot) 'docs\outputs\AidLink_Requirements_Traceability_Status_10Column.docx'
$temporaryOutput = Join-Path (Split-Path -Parent $PSScriptRoot) 'docs\outputs\AidLink_Requirements_Traceability_Status.tmp.docx'
$word = New-Object -ComObject Word.Application
$word.Visible = $false
$sourceDocument = $word.Documents.Open($sourceOutput, $false, $true)
$sourceTable = $sourceDocument.Tables.Item(1)
$rows = @()
for ($r = 2; $r -le $sourceTable.Rows.Count; $r++) {
  $cells = @()
  for ($c = 1; $c -le $sourceTable.Columns.Count; $c++) {
    $cells += $sourceTable.Cell($r, $c).Range.Text.Trim([char]13, [char]7).Trim()
  }
  if ($cells[0] -match '^(FR-|NFR-|DR-|INT-)') { $rows += ,$cells }
}
$sourceDocument.Close($false)
[System.Runtime.InteropServices.Marshal]::ReleaseComObject($sourceTable) | Out-Null
[System.Runtime.InteropServices.Marshal]::ReleaseComObject($sourceDocument) | Out-Null

$word.Quit()
[System.Runtime.InteropServices.Marshal]::ReleaseComObject($word) | Out-Null
$word = New-Object -ComObject Word.Application
$word.Visible = $false
$document = $word.Documents.Add()
$section = $document.Sections.Item(1)
$section.PageSetup.Orientation = 1
$section.PageSetup.PageWidth = 792
$section.PageSetup.PageHeight = 612
$section.PageSetup.LeftMargin = 28
$section.PageSetup.RightMargin = 28
$section.PageSetup.TopMargin = 32
$section.PageSetup.BottomMargin = 32

$selection = $word.Selection
$selection.Style = 'Title'
$selection.Font.Name = 'Aptos Display'
$selection.Font.Size = 20
$selection.Font.Bold = $true
$selection.Font.Color = 0x1F4E78
$selection.TypeText('AidLink Requirements Traceability Status')
$selection.TypeParagraph()
$selection.Style = 'Normal'
$selection.Font.Name = 'Aptos'
$selection.Font.Size = 9
$selection.Font.Color = 0
$selection.TypeText('Current prototype assessment based on the implementation and automated test evidence available in the AidLink workspace.')
$selection.TypeParagraph()
$selection.TypeParagraph()

$meta = @(
  'Project Title: ______________________________    Team / Proponents: __________________________',
  'Client / Partner: ____________________________    Capstone Adviser: _________________________',
  'System / Build Version: ______________________    Testing Period: ____________________________',
  'Document Version: 1.0'
)
foreach ($line in $meta) { $selection.TypeText($line); $selection.TypeParagraph() }
$selection.TypeParagraph()

$selection.Font.Bold = $true
$selection.Font.Size = 12
$selection.Font.Color = 0x1F4E78
$selection.TypeText('Requirements Traceability Matrix')
$selection.TypeParagraph()
$selection.Font.Bold = $false
$selection.Font.Size = 8
$selection.Font.Color = 0

$table = $document.Tables.Add($selection.Range, $rows.Count + 1, 10)
$table.AllowAutoFit = $false
$table.Rows.Alignment = 1
$table.Borders.Enable = $true
$table.Borders.OutsideLineStyle = 1
$table.Borders.InsideLineStyle = 1
$widths = @(36, 72, 112, 48, 105, 92, 105, 80, 70, 108)
for ($i = 1; $i -le 10; $i++) { $table.Columns.Item($i).Width = $widths[$i - 1] }
$headers = @('Req. ID', 'Objective / Stakeholder Need', 'Requirement Statement', 'Type / Priority', 'Acceptance Criteria', 'Design / Component Reference', 'Implementation Evidence', 'Test / Validation Reference', 'Latest Result / Status', 'Remarks / Change Reference')
for ($c = 1; $c -le 10; $c++) {
  $cell = $table.Cell(1, $c)
  $cell.Range.Text = $headers[$c - 1]
  $cell.Range.Font.Name = 'Aptos'
  $cell.Range.Font.Size = 7
  $cell.Range.Font.Bold = $true
  $cell.Range.Font.Color = 0xFFFFFF
  $cell.VerticalAlignment = 1
  $cell.Shading.BackgroundPatternColor = 0x1F4E78
}
$table.Rows.Item(1).HeadingFormat = $true
for ($r = 0; $r -lt $rows.Count; $r++) {
  $row = $rows[$r]
  $id = $row[0]
  $type = if ($id -match '^FR-') { 'Functional' } elseif ($id -match '^NFR-') { 'Non-functional' } elseif ($id -match '^DR-') { 'Data' } else { 'Integration' }
  $priority = if ($id -match 'FR-0[1-9]|FR-1[0-9]|FR-2[0-4]|NFR-0[1-6]|NFR-08|NFR-11|NFR-12|DR-0[1-2]') { 'High' } else { 'Medium / Low' }
  $criteria = if ($row[4] -match 'Implemented / Tested') { 'Related automated checks pass and the stated behavior is available.' } elseif ($row[4] -match 'Implemented') { 'The behavior is available and requires dedicated acceptance evidence.' } elseif ($row[4] -match 'Partial') { 'The available portion works; remaining scope must be completed.' } elseif ($row[4] -match 'Excluded') { 'The function is outside the approved prototype scope.' } else { 'Complete the implementation and verify it before production.' }
  $design = if ($id -match '^FR-0[1-4]') { 'Authentication and applicant workflow' } elseif ($id -match '^FR-0[5-9]|FR-1') { 'Application intake and document workflow' } elseif ($id -match '^FR-2[0-4]') { 'Administration, protected letter, and QR workflow' } elseif ($id -match '^NFR-') { 'Security, privacy, and deployment controls' } elseif ($id -match '^DR-') { 'Data model and persistence layer' } else { 'External integration adapter' }
  $testReference = if ($row[5] -match 'server/[^; ]+\.test\.js') { [regex]::Match($row[5], 'server/[^; ]+\.test\.js').Value } elseif ($id -match '^NFR-07|NFR-09|NFR-10') { 'UAT / performance / compatibility test required' } elseif ($id -match '^DR-|^INT-') { 'Future migration or integration test' } else { 'Automated backend and component tests' }
  $outputRow = @($id, $row[1], $row[2], "$type / $priority", $criteria, $design, $row[5], $testReference, $row[4], $row[6])
  for ($c = 0; $c -lt 10; $c++) {
    $cell = $table.Cell($r + 2, $c + 1)
    $text = $outputRow[$c] -replace '`', ''
    $cell.Range.Text = $text
    $cell.Range.Font.Name = 'Aptos'
    $cell.Range.Font.Size = 6.5
    $cell.Range.Font.Color = 0
    $cell.VerticalAlignment = 0
    if (($r % 2) -eq 1) { $cell.Shading.BackgroundPatternColor = 0xF2F6FA }
  }
  $status = $row[4]
  $statusCell = $table.Cell($r + 2, 9)
  if ($status -match 'Planned|Deferred|Excluded') {
    $statusCell.Shading.BackgroundPatternColor = 0xFCE4D6
    $statusCell.Range.Font.Color = 0x9C0006
  } elseif ($status -match 'Partial') {
    $statusCell.Shading.BackgroundPatternColor = 0xFFF2CC
    $statusCell.Range.Font.Color = 0x7F6000
  } else {
    $statusCell.Shading.BackgroundPatternColor = 0xE2F0D9
    $statusCell.Range.Font.Color = 0x375623
  }
  $table.Rows.Item($r + 2).AllowBreakAcrossPages = $true
}

$range = $document.Range($document.Content.End - 1, $document.Content.End - 1)
$range.InsertParagraphAfter()
$range.InsertParagraphAfter()
$range.Collapse(0)
$range.Font.Name = 'Aptos'
$range.Font.Size = 12
$range.Font.Bold = $true
$range.Font.Color = 0x1F4E78
$range.InsertAfter('Automated Test Summary')
$range.InsertParagraphAfter()
$range.Font.Size = 9
$range.Font.Bold = $false
$range.Font.Color = 0
$range.InsertAfter('Latest backend run: 17 passed and 4 failed tests. Failed areas: Guarantee Letter approval/release status expectations, Word-to-PDF conversion failure status, request workflow-order status, and approval SMS notification status.')
$range.InsertParagraphAfter()
$range.InsertParagraphAfter()
$range.Font.Size = 12
$range.Font.Bold = $true
$range.Font.Color = 0x1F4E78
$range.InsertAfter('Production Readiness Summary')
$range.InsertParagraphAfter()
$range.Font.Size = 9
$range.Font.Bold = $false
$range.Font.Color = 0
$range.InsertAfter('The current system is suitable for controlled demonstration and continued development. PostgreSQL migration, automated backup and recovery, production document retention and deletion, malware scanning, HTTPS enforcement, monitoring, formal privacy approval, partner integration, and acceptance testing remain incomplete.')

$document.SaveAs2($temporaryOutput, 16)
$document.Close()
$word.Quit()
[System.Runtime.InteropServices.Marshal]::ReleaseComObject($selection) | Out-Null
[System.Runtime.InteropServices.Marshal]::ReleaseComObject($document) | Out-Null
[System.Runtime.InteropServices.Marshal]::ReleaseComObject($word) | Out-Null
Remove-Item -LiteralPath $output -Force -ErrorAction SilentlyContinue
Move-Item -LiteralPath $temporaryOutput -Destination $output
Write-Output "Created $output"
