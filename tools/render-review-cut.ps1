param(
  [Parameter(Mandatory=$true)][string]$InputDirectory,
  [Parameter(Mandatory=$true)][string]$OutputDirectory,
  [switch]$NoNarration
)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$scopeInput=(Resolve-Path -LiteralPath $InputDirectory).Path
$scopeOutput=[IO.Path]::GetFullPath($OutputDirectory)
if(Test-Path -LiteralPath $scopeOutput){throw 'Choose a new output directory; existing artifacts are preserved.'}
$scopeReceipt=Get-Content -LiteralPath (Join-Path $scopeInput 'receipt.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if($scopeReceipt.status -ne 'passed' -or $scopeReceipt.realProviderInference -ne $false -or $scopeReceipt.realPaypalPayment -ne $false){throw 'A passed, explicitly authored recording receipt is required.'}
$scopeVideo=Join-Path $scopeInput 'review-cut.webm'
if((Get-FileHash -LiteralPath $scopeVideo -Algorithm SHA256).Hash.ToLowerInvariant() -ne $scopeReceipt.videoSha256){throw 'Recording does not match its retained digest.'}
$scopeFfmpeg=(Get-Command ffmpeg.exe -ErrorAction Stop).Source
$scopeFfprobe=(Get-Command ffprobe.exe -ErrorAction Stop).Source
$scopeDuration=[double]::Parse((& $scopeFfprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 $scopeVideo),[Globalization.CultureInfo]::InvariantCulture)
if($LASTEXITCODE -ne 0 -or $scopeDuration -lt 140 -or $scopeDuration -ge 180){throw 'The review cut must be between 140 and 180 seconds.'}
New-Item -ItemType Directory -Path $scopeOutput | Out-Null
$scopeArguments=@('-hide_banner','-loglevel','error','-i',$scopeVideo)
$scopeFilters=@();$scopeAudioLabels=@();$scopeIndex=0;$scopeVoice='none'
if(-not $NoNarration){
  Add-Type -AssemblyName System.Speech
  $scopeSynth=New-Object System.Speech.Synthesis.SpeechSynthesizer
  try{
    $scopeVoices=@($scopeSynth.GetInstalledVoices() | Where-Object {$_.Enabled -and $_.VoiceInfo.Culture.TwoLetterISOLanguageName -eq 'en'} | Sort-Object {$_.VoiceInfo.Name})
    if($scopeVoices.Count -eq 0){throw 'No installed English voice. Use -NoNarration for a captioned review cut.'}
    $scopeVoice=$scopeVoices[0].VoiceInfo.Name;$scopeSynth.SelectVoice($scopeVoice);$scopeSynth.Rate=1
    foreach($scopeChapter in $scopeReceipt.chapters){
      $scopeWav=Join-Path $scopeOutput ('narration-'+$scopeIndex+'.wav')
      $scopeSynth.SetOutputToWaveFile($scopeWav);$scopeSynth.Speak([string]$scopeChapter.narration);$scopeSynth.SetOutputToNull()
      $scopeSpeechDuration=[double]::Parse((& $scopeFfprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 $scopeWav),[Globalization.CultureInfo]::InvariantCulture)
      if($LASTEXITCODE -ne 0 -or $scopeSpeechDuration -gt ([double]$scopeChapter.end-[double]$scopeChapter.at)){throw ('Narration exceeds its scene budget: '+$scopeChapter.title)}
      $scopeArguments+=@('-i',$scopeWav);$scopeDelay=[int]([double]$scopeChapter.at*1000);$scopeInputIndex=$scopeIndex+1
      $scopeFilters+=('['+$scopeInputIndex+':a]adelay='+$scopeDelay+'|'+$scopeDelay+'[speech'+$scopeIndex+']');$scopeAudioLabels+=('[speech'+$scopeIndex+']');$scopeIndex++
    }
  }finally{$scopeSynth.Dispose()}
  $scopeFilters+=(($scopeAudioLabels -join '')+'amix=inputs='+$scopeIndex+':normalize=0:duration=longest:dropout_transition=0,apad[narration]')
  $scopeArguments+=@('-filter_complex',($scopeFilters -join ';'),'-map','0:v:0','-map','[narration]','-c:a','aac','-b:a','128k')
}else{$scopeArguments+=@('-map','0:v:0','-an')}
$scopeMovie=Join-Path $scopeOutput 'scope-review-cut.mp4'
$scopeArguments+=@('-c:v','libx264','-preset','medium','-crf','22','-pix_fmt','yuv420p','-t',$scopeDuration.ToString([Globalization.CultureInfo]::InvariantCulture),'-movflags','+faststart',$scopeMovie)
& $scopeFfmpeg @scopeArguments
if($LASTEXITCODE -ne 0){throw 'Review-cut encoding failed.'}
$scopeMetadata=& $scopeFfprobe -v error -show_entries format=duration:stream=codec_name,codec_type,width,height -of json $scopeMovie | ConvertFrom-Json
if($LASTEXITCODE -ne 0 -or [double]::Parse($scopeMetadata.format.duration,[Globalization.CultureInfo]::InvariantCulture) -ge 180){throw 'Encoded video verification failed.'}
$scopeRenderReceipt=[ordered]@{kind='scope_review_cut_render_v1';sourceTree=$scopeReceipt.sourceTree;inputVideoSha256=$scopeReceipt.videoSha256;outputSha256=(Get-FileHash -LiteralPath $scopeMovie -Algorithm SHA256).Hash.ToLowerInvariant();voice=$scopeVoice;syntheticNarration=(-not $NoNarration);durationSeconds=$scopeMetadata.format.duration;authoredIdentities=$true;authoredAIReplay=$true;authoredPaypalResponses=$true;realPaypalPayment=$false;publicYouTubeVideo=$false;devpostEntry=$false}
$scopeRenderReceipt | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $scopeOutput 'render-receipt.json') -Encoding UTF8
Write-Output ('Created '+$scopeMovie)
