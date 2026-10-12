type LanguageCode = 'de' | 'en';

const UI_TEXTS = {
    de: UI_TEXT_DE,
    en: UI_TEXT_EN
} as const;

let currentLanguage: LanguageCode = 'en';
let UI_TEXT: (typeof UI_TEXTS)[LanguageCode] = UI_TEXTS[currentLanguage];

function getIntlLocale(): string {
    return currentLanguage === 'en' ? 'en-US' : 'de-DE';
}

function formatUiDate(input: string | Date): string {
    return formatVodCardDate(input);
}

function formatVodCardDate(input: string | Date): string {
    const date = input instanceof Date ? input : new Date(input);
    if (Number.isNaN(date.getTime())) return '';
    const day = String(date.getDate()).padStart(2, '0');
    const month = String(date.getMonth() + 1).padStart(2, '0');
    return `${day}.${month}.${date.getFullYear()}`;
}

function formatUiDateTime(input: string | Date): string {
    const date = input instanceof Date ? input : new Date(input);
    if (Number.isNaN(date.getTime())) return '';
    const time = date.toLocaleTimeString(getIntlLocale(), {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
    });
    return `${formatVodCardDate(date)}, ${time}`;
}

function formatUiNumber(value: number): string {
    return value.toLocaleString(getIntlLocale());
}

function setText(id: string, value: string): void {
    const node = document.getElementById(id);
    if (node) node.textContent = value;
}

function setAriaLabelAll(selector: string, value: string): void {
    document.querySelectorAll(selector).forEach((el) => {
        el.setAttribute('aria-label', value);
    });
}

function setPlaceholder(id: string, value: string): void {
    const node = document.getElementById(id) as HTMLInputElement | null;
    if (node) node.placeholder = value;
}

function setTitle(id: string, value: string): void {
    const node = document.getElementById(id);
    if (node) node.setAttribute('title', value);
}

function setAriaLabel(id: string, value: string): void {
    const node = document.getElementById(id);
    if (node) node.setAttribute('aria-label', value);
}

function setLanguage(lang: string): LanguageCode {
    currentLanguage = lang === 'en' ? 'en' : 'de';
    RendererAccessibility.setDocumentLanguage(currentLanguage);
    UI_TEXT = UI_TEXTS[currentLanguage];
    applyLanguageToStaticUI();
    return currentLanguage;
}

function applyLanguageToStaticUI(): void {
    setText('logoText', UI_TEXT.appName);
    setText('navVodsText', UI_TEXT.static.navVods);
    setText('navClipsText', UI_TEXT.static.navClips);
    setText('navCutterText', UI_TEXT.static.navCutter);
    setText('navMergeText', UI_TEXT.static.navMerge);
    setText('navStatsText', UI_TEXT.static.navStats);
    setText('navArchiveText', UI_TEXT.static.navArchive);
    setAriaLabelAll('.top-nav', UI_TEXT.static.mainNavigationAria);
    setAriaLabelAll('.context-sidebar', UI_TEXT.static.workspaceContextAria);
    setAriaLabelAll('[data-context-for="vods"] .context-switcher', UI_TEXT.static.vodWorkspaceAria);
    setAriaLabelAll('[data-context-for="clips"] .context-list', UI_TEXT.static.clipSectionsAria);
    setAriaLabelAll('[data-context-for="cutter"] .context-list', UI_TEXT.static.cutterSectionsAria);
    setAriaLabelAll('[data-context-for="merge"] .context-list', UI_TEXT.static.mergeSectionsAria);
    setAriaLabelAll('[data-context-for="stats"] .context-list', UI_TEXT.static.statisticsSectionsAria);
    setAriaLabelAll('[data-context-for="archive"] .context-list', UI_TEXT.static.archiveSectionsAria);
    setAriaLabelAll('[data-context-for="settings"] .context-list', UI_TEXT.static.settingsSectionsAria);
    setAriaLabel('toolbarCutBtn', UI_TEXT.static.cutVideoAction);
    setTitle('toolbarCutBtn', UI_TEXT.static.cutVideoAction);
    setAriaLabel('toolbarMergeBtn', UI_TEXT.static.mergeVideosAction);
    setTitle('toolbarMergeBtn', UI_TEXT.static.mergeVideosAction);
    document.querySelectorAll<HTMLButtonElement>('.top-nav [data-tab]').forEach((button) => {
        const tab = button.dataset.tab;
        const titles: Record<string, string> = {
            vods: UI_TEXT.static.navVods,
            clips: UI_TEXT.static.navClips,
            cutter: UI_TEXT.static.navCutter,
            merge: UI_TEXT.static.navMerge,
            stats: UI_TEXT.static.navStats,
            archive: UI_TEXT.static.navArchive,
            settings: UI_TEXT.static.navSettings
        };
        button.title = tab ? titles[tab] || '' : '';
    });
    setText('archiveResultsNavText', UI_TEXT.static.archiveResults);
    setText('archiveTitle', UI_TEXT.static.archiveTitle);
    setText('archiveQueryLabel', UI_TEXT.static.archiveQueryLabel);
    setText('archiveTypeLabel', UI_TEXT.static.archiveTypeLabel);
    setText('archiveStreamerLabel', UI_TEXT.static.archiveStreamerLabel);
    setText('archiveSortLabel', UI_TEXT.static.archiveSortLabel);
    setText('archiveResultsTitle', UI_TEXT.static.archiveResults);
    if (typeof refreshArchiveSearchTexts === 'function') refreshArchiveSearchTexts();
    setText('btnArchiveSearch', UI_TEXT.static.archiveSearchBtn);
    const archiveQueryInput = document.getElementById('archiveSearchQuery') as HTMLInputElement | null;
    if (archiveQueryInput) archiveQueryInput.placeholder = UI_TEXT.static.archiveSearchPlaceholder;
    setAriaLabel('archiveSearchQuery', UI_TEXT.static.archiveSearchAria);
    const archiveTypeSelect = document.getElementById('archiveSearchType') as HTMLSelectElement | null;
    if (archiveTypeSelect) {
        const opts = archiveTypeSelect.options;
        if (opts[0]) opts[0].text = UI_TEXT.static.archiveAllTypes;
        if (opts[1]) opts[1].text = UI_TEXT.static.archiveTypeLive;
        if (opts[2]) opts[2].text = UI_TEXT.static.archiveTypeVod;
        if (opts[3]) opts[3].text = UI_TEXT.static.archiveTypeClip;
    }
    const archiveSortSelect = document.getElementById('archiveSearchSort') as HTMLSelectElement | null;
    if (archiveSortSelect) {
        const opts = archiveSortSelect.options;
        if (opts[0]) opts[0].text = UI_TEXT.static.archiveSortDateDesc;
        if (opts[1]) opts[1].text = UI_TEXT.static.archiveSortDateAsc;
        if (opts[2]) opts[2].text = UI_TEXT.static.archiveSortSizeDesc;
        if (opts[3]) opts[3].text = UI_TEXT.static.archiveSortSizeAsc;
        if (opts[4]) opts[4].text = UI_TEXT.static.archiveSortNameAsc;
    }
    setText('navSettingsText', UI_TEXT.static.navSettings);
    setText('statsTitle', UI_TEXT.static.statsTitle);
    setText('statsSummaryTitle', UI_TEXT.static.statsSummaryTitle);
    setText('statsInventoryTitle', UI_TEXT.static.statsInventoryTitle);
    if (typeof refreshArchiveStatsTexts === 'function') refreshArchiveStatsTexts();
    setText('statsTopStreamersTitle', UI_TEXT.static.statsTopStreamersTitle);
    setText('statsActivityTitle', UI_TEXT.static.statsActivityTitle);
    setText('statsSizeBucketsTitle', UI_TEXT.static.statsSizeBucketsTitle);
    setText('btnStatsRefresh', UI_TEXT.static.statsRefresh);
    setText('queueTitleText', UI_TEXT.static.queueTitle);
    setText('streamerWorkspaceSwitch', UI_TEXT.static.streamerSectionTitle);
    setText('queueWorkspaceSwitch', UI_TEXT.static.queueTitle);
    setText('healthBadge', UI_TEXT.static.healthUnknown);
    setText('btnRetryFailed', UI_TEXT.static.retryFailed);
    setTitle('btnRetryFailed', UI_TEXT.static.retryFailedHint);
    setText('btnClear', UI_TEXT.static.clearQueue);
    setText('refreshText', UI_TEXT.static.refresh);
    setText('clipsHeading', UI_TEXT.static.clipsHeading);
    setText('clipsInfoTitle', UI_TEXT.static.clipsInfoTitle);
    setText('clipsInfoText', UI_TEXT.static.clipsInfoText);
    setPlaceholder('clipFilenameTemplate', UI_TEXT.clips.templatePlaceholder);
    setText('clipDialogStartLabel', UI_TEXT.clips.dialogStart);
    setText('clipDialogStartTimeLabel', UI_TEXT.clips.dialogStartTime);
    setText('clipDialogEndLabel', UI_TEXT.clips.dialogEnd);
    setText('clipDialogEndTimeLabel', UI_TEXT.clips.dialogEndTime);
    for (const which of ['Start', 'End']) {
        const label = which === 'Start' ? UI_TEXT.clips.dialogStartTime : UI_TEXT.clips.dialogEndTime;
        for (const direction of ['Earlier', 'Later']) {
            const description = label + ': ' + (direction === 'Earlier' ? UI_TEXT.clips.timeEarlier : UI_TEXT.clips.timeLater);
            setAriaLabel('clip' + which + direction, description);
            setTitle('clip' + which + direction, description);
        }
    }
    setText('clipDialogDurationLabel', UI_TEXT.clips.dialogDuration);
    setText('clipDialogPartLabel', UI_TEXT.clips.dialogPartLabel);
    setText('clipDialogFormatLabel', UI_TEXT.clips.dialogFormatLabel);
    setText('clipDialogConfirmBtn', UI_TEXT.clips.dialogConfirm);
    setText('clipTimeHint', UI_TEXT.clips.timeInputHint);
    setText('clipSelectionTitle', UI_TEXT.clips.selectionTitle);
    setText('clipSeekStart', UI_TEXT.clips.seekStart);
    setText('clipSeekEnd', UI_TEXT.clips.seekEnd);
    setText('clipFilenameOptionsTitle', UI_TEXT.clips.filenameOptions);
    setText('clipQueueHint', '');
    setText('clipCancelBtn', UI_TEXT.clips.close);
    setPlaceholder('clipUrl', UI_TEXT.clips.urlPlaceholder);
    setText('clipsBatchHint', UI_TEXT.clips.batchHint);
    setText('clipsLinksLabel', UI_TEXT.clips.linksLabel);
    setText('clipsClearBtn', UI_TEXT.clips.clearList);
    setText('clipsRetryBtn', UI_TEXT.clips.retryFailed);
    setText('clipsResultsTitle', UI_TEXT.clips.resultsTitle);
    setAriaLabel('clipsBatchProgress', UI_TEXT.clips.resultsTitle);
    renderClipBatch();
    setPlaceholder('clipStartPart', UI_TEXT.clips.startPartPlaceholder);
    setPlaceholder('cutterFilePath', UI_TEXT.cutter.filePathPlaceholder);
    setText('cutterSelectTitle', UI_TEXT.static.cutterSelectTitle);
    setText('cutterPreviewPlaceholder', UI_TEXT.static.cutterPreviewPlaceholder);
    setText('cutterBrowseBtn', UI_TEXT.static.cutterBrowse);
    setText('cutterNewVideoText', UI_TEXT.cutter.newVideo);
    setAriaLabel('cutterOpenProjectBtn', UI_TEXT.cutter.openProject);
    setTitle('cutterOpenProjectBtn', UI_TEXT.cutter.openProject);
    setAriaLabel('cutterSaveProjectBtn', UI_TEXT.cutter.saveProject);
    setTitle('cutterSaveProjectBtn', UI_TEXT.cutter.saveProject);
    setText('commandPaletteTitle', UI_TEXT.static.commandPaletteTitle);
    setAriaLabel('commandPaletteInput', UI_TEXT.static.commandPaletteAria);
    setAriaLabel('commandPaletteList', UI_TEXT.static.commandPaletteResultsAria);
    setPlaceholder('commandPaletteInput', UI_TEXT.static.commandPaletteSearchPlaceholder);
    setText('commandPaletteHint', UI_TEXT.static.commandPaletteHint);
    setText('cutterInfoDurationLabel', UI_TEXT.cutter.infoDuration);
    setText('cutterInfoResolutionLabel', UI_TEXT.cutter.infoResolution);
    setText('cutterInfoFpsLabel', UI_TEXT.cutter.infoFps);
    setText('cutterInfoSelectionLabel', UI_TEXT.cutter.infoSelection);
    setText('cutterDiscardTitle', UI_TEXT.cutter.discardTitle);
    setText('cutterDiscardMessage', UI_TEXT.cutter.discardMessage);
    setText('cutterDiscardCancelBtn', UI_TEXT.cutter.discardCancel);
    setText('cutterDiscardConfirmBtn', UI_TEXT.cutter.discardConfirm);
    setText('cutterStartLabel', UI_TEXT.cutter.startLabel);
    setText('cutterEndLabel', UI_TEXT.cutter.endLabel);
    setText('btnCut', UI_TEXT.cutter.cut);
    setText('cutterEditHeading', UI_TEXT.cutter.editorTitle);
    setText('cutterPreviewModeLabel', UI_TEXT.cutter.previewMode);
    setText('cutterPreviewModeHint', UI_TEXT.cutter.previewModeHint);
    setText('cutterGlobalTrimLabel', UI_TEXT.cutter.globalTrim);
    setText('cutterCutsLabel', UI_TEXT.cutter.cutsLabel);
    setText('cutterCutEmpty', UI_TEXT.cutter.noCuts);
    setText('cutterVideoTrackLabel', UI_TEXT.cutter.videoTrack);
    setText('cutterAudioTrackLabel', UI_TEXT.cutter.audioTrack);
    setText('cutterAudioEmpty', UI_TEXT.cutter.noAudio);
    setText('cutterRecoveryText', UI_TEXT.cutter.recoveryFound);
    setText('cutterRecoveryRestoreBtn', UI_TEXT.cutter.recoverProject);
    setText('cutterRecoveryDiscardBtn', UI_TEXT.cutter.discardProject);
    setText('cutterExportProfileLabel', UI_TEXT.cutter.exportProfileLabel);
    setText('cutterExportEncoderLabel', UI_TEXT.cutter.exportEncoderLabel);
    setText('cutterAudioStreamLabel', UI_TEXT.cutter.audioStreamLabel);
    setText('cutterProfileQualityOption', UI_TEXT.cutter.profileQuality);
    setText('cutterProfileBalancedOption', UI_TEXT.cutter.profileBalanced);
    setText('cutterProfileFastOption', UI_TEXT.cutter.profileFast);
    setText('cutterProfileArchiveOption', UI_TEXT.cutter.profileArchive);
    setText('cutterEncoderSoftwareOption', UI_TEXT.cutter.encoderSoftware);
    setText('cutterAudioStreamEmptyOption', UI_TEXT.cutter.noAudio);
    setText('cutterSpeedNormalBtn', UI_TEXT.cutter.speedNormal);
    setText('cutterLoadingLabel', UI_TEXT.cutter.loadingMedia);
    setText('cutterSpeedLabel', UI_TEXT.cutter.speedLabel);
    setAriaLabel('cutterPlayBtn', UI_TEXT.cutter.play);
    setAriaLabel('cutterStopBtn', UI_TEXT.cutter.stop);
    setAriaLabel('cutterRewindBtn', UI_TEXT.cutter.rewind10);
    setAriaLabel('cutterForwardBtn', UI_TEXT.cutter.forward10);
    setAriaLabel('cutterMuteBtn', UI_TEXT.cutter.mute);
    setAriaLabel('cutterVolume', UI_TEXT.cutter.volume);
    setAriaLabel('cutterSettingsBtn', UI_TEXT.cutter.playerSettings);
    setAriaLabel('cutterFullscreenBtn', UI_TEXT.cutter.fullscreen);
    setAriaLabel('cutterUndoBtn', UI_TEXT.cutter.undo);
    setAriaLabel('cutterRedoBtn', UI_TEXT.cutter.redo);
    setAriaLabel('cutterZoomOutBtn', UI_TEXT.cutter.zoomOut);
    setAriaLabel('cutterZoomInBtn', UI_TEXT.cutter.zoomIn);
    setAriaLabel('cutterZoom', UI_TEXT.cutter.zoom);
    setAriaLabel('cutterTrimStartHandle', UI_TEXT.cutter.trimStart);
    setAriaLabel('cutterTrimEndHandle', UI_TEXT.cutter.trimEnd);
    setText('cutterCancelExportBtn', UI_TEXT.cutter.cancel);
    setAriaLabel('cutterNewCutBtn', UI_TEXT.cutter.newCut);
    setTitle('cutterNewCutBtn', UI_TEXT.cutter.newCut);
    setText('mergeTitle', UI_TEXT.static.mergeTitle);
    setText('mergeAddBtn', UI_TEXT.static.mergeAdd);
    setText('btnMerge', UI_TEXT.merge.merge);
    setText('designTitle', UI_TEXT.static.designTitle);
    setText('themeLabel', UI_TEXT.static.themeLabel);
    setText('themeLightOption', UI_TEXT.static.themeLight);
    setText('themeDarkOption', UI_TEXT.static.themeDark);
    setText('themeSystemOption', UI_TEXT.static.themeSystem);
    setText('languageLabel', UI_TEXT.static.languageLabel);
    setText('languageDeText', UI_TEXT.static.languageDe);
    setText('languageEnText', UI_TEXT.static.languageEn);
    setText('apiTitle', UI_TEXT.static.apiTitle);
    setText('apiHelpLink', UI_TEXT.static.apiHelpLinkText);
    setText('clientIdLabel', UI_TEXT.static.clientIdLabel);
    setText('clientSecretLabel', UI_TEXT.static.clientSecretLabel);
    setText('saveSettingsBtn', UI_TEXT.static.saveSettings);
    setText('downloadSettingsTitle', UI_TEXT.static.downloadSettingsTitle);
    setText('downloadBasicsTitle', UI_TEXT.static.downloadBasicsTitle);
    setText('queueAutomationTitle', UI_TEXT.static.queueAutomationTitle);
    setText('recordingMetadataTitle', UI_TEXT.static.recordingMetadataTitle);
    setText('sidebarSplitViewLabel', UI_TEXT.static.sidebarSplitViewLabel);
    setText('storageLabel', UI_TEXT.static.storageLabel);
    setText('selectFolderBtn', UI_TEXT.static.selectFolder);
    setText('openFolderBtn', UI_TEXT.static.openFolder);
    setText('modeLabel', UI_TEXT.static.modeLabel);
    setText('modeFullText', UI_TEXT.static.modeFull);
    setText('modePartsText', UI_TEXT.static.modeParts);
    setText('partMinutesLabel', UI_TEXT.static.partMinutesLabel);
    setText('parallelDownloadsLabel', UI_TEXT.static.parallelDownloadsLabel);
    setText('parallelDownloads1', UI_TEXT.static.parallelDownloads1);
    setText('parallelDownloads2', UI_TEXT.static.parallelDownloads2);
    setText('performanceModeLabel', UI_TEXT.static.performanceModeLabel);
    setText('performanceModeStability', UI_TEXT.static.performanceModeStability);
    setText('performanceModeBalanced', UI_TEXT.static.performanceModeBalanced);
    setText('performanceModeSpeed', UI_TEXT.static.performanceModeSpeed);
    setText('duplicatePreventionLabel', UI_TEXT.static.duplicatePreventionLabel);
    setText('persistQueueLabel', UI_TEXT.static.persistQueueLabel);
    setText('autoResumeQueueLabel', UI_TEXT.static.autoResumeQueueLabel);
    setText('notifyEachCompletionLabel', UI_TEXT.static.notifyEachCompletionLabel);
    setText('streamlinkDisableAdsLabel', UI_TEXT.static.streamlinkDisableAdsLabel);
    setText('downloadChatReplayLabel', UI_TEXT.static.downloadChatReplayLabel);
    setText('captureLiveChatLabel', UI_TEXT.static.captureLiveChatLabel);
    setText('logStreamEventsLabel', UI_TEXT.static.logStreamEventsLabel);
    setText('streamlinkQualityLabel', UI_TEXT.static.streamlinkQualityLabel);
    setText('downloadPolicyTitle', UI_TEXT.static.downloadPolicyTitle);
    setText('downloadThrottleLabel', UI_TEXT.static.downloadThrottleLabel);
    setText('downloadThrottleHint', UI_TEXT.static.downloadThrottleHint);
    setText('downloadWindowsLabel', UI_TEXT.static.downloadWindowsLabel);
    setText('downloadWindowsHint', UI_TEXT.static.downloadWindowsHint);
    setText('downloadPolicyOverrideBtn', UI_TEXT.static.downloadPolicyOverride);
    setText('streamerSectionTitleText', UI_TEXT.static.streamerSectionTitle);
    setPlaceholder('streamerListFilter', UI_TEXT.static.streamerListFilterPlaceholder);
    setAriaLabel('streamerListFilter', UI_TEXT.static.streamerListFilterAria);
    setTitle('btnStreamerBulkRemove', UI_TEXT.static.streamerBulkRemoveTitle);
    setAriaLabel('btnStreamerBulkRemove', UI_TEXT.static.streamerBulkRemoveTitle);
    setAriaLabel('btnAddStreamer', UI_TEXT.static.streamerAddAriaLabel);
    setTitle('btnAddStreamer', UI_TEXT.static.streamerAddAriaLabel);
    setText('metadataCacheMinutesLabel', UI_TEXT.static.metadataCacheMinutesLabel);
    setText('filenameTemplatesTitle', UI_TEXT.static.filenameTemplatesTitle);
    setText('vodTemplateLabel', UI_TEXT.static.vodTemplateLabel);
    setText('partsTemplateLabel', UI_TEXT.static.partsTemplateLabel);
    setText('defaultClipTemplateLabel', UI_TEXT.static.defaultClipTemplateLabel);
    setText('filenameTemplateLint', '');
    setText('settingsTemplateGuideBtn', UI_TEXT.static.templateGuideButton);
    setText('clipTemplateGuideBtn', UI_TEXT.static.templateGuideButton);
    setText('clipTemplateLint', '');
    setText('templateGuideTitle', UI_TEXT.static.templateGuideTitle);
    setText('templateGuideTemplateLabel', UI_TEXT.static.templateGuideTemplateLabel);
    setText('templateGuideOutputLabel', UI_TEXT.static.templateGuideOutputLabel);
    setText('templateGuideVarsTitle', UI_TEXT.static.templateGuideVarsTitle);
    setText('templateGuideVarCol', UI_TEXT.static.templateGuideVarCol);
    setText('templateGuideDescCol', UI_TEXT.static.templateGuideDescCol);
    setText('templateGuideExampleCol', UI_TEXT.static.templateGuideExampleCol);
    setText('templateGuideUseVod', UI_TEXT.static.templateGuideUseVod);
    setText('templateGuideUseParts', UI_TEXT.static.templateGuideUseParts);
    setText('templateGuideUseClip', UI_TEXT.static.templateGuideUseClip);
    setText('templateGuideCloseBtn', UI_TEXT.static.templateGuideClose);
    setPlaceholder('templateGuideInput', UI_TEXT.static.vodTemplatePlaceholder);
    setPlaceholder('vodFilenameTemplate', UI_TEXT.static.vodTemplatePlaceholder);
    setPlaceholder('partsFilenameTemplate', UI_TEXT.static.partsTemplatePlaceholder);
    setPlaceholder('defaultClipFilenameTemplate', UI_TEXT.static.defaultClipTemplatePlaceholder);
    setText('updateTitle', UI_TEXT.static.updateTitle);
    setText('checkUpdateBtn', UI_TEXT.static.checkUpdates);
    setText('preflightTitle', UI_TEXT.static.preflightTitle);
    setText('btnPreflightRun', UI_TEXT.static.preflightRun);
    setText('btnPreflightFix', UI_TEXT.static.preflightFix);
    setText('preflightResult', UI_TEXT.static.preflightEmpty);
    if (typeof refreshLocalizedPreflightUi === 'function') refreshLocalizedPreflightUi();
    setText('managedToolsTitle', UI_TEXT.static.managedToolsTitle);
    setText('btnRefreshManagedTools', UI_TEXT.static.managedToolsRefresh);
    setText('btnRepairManagedTools', UI_TEXT.static.managedToolsRepair);
    setText('btnResetManagedTools', UI_TEXT.static.managedToolsReset);
    setText('managedToolStatus', UI_TEXT.static.managedToolsEmpty);
    setText('debugLogTitle', UI_TEXT.static.debugLogTitle);
    setText('btnRefreshLog', UI_TEXT.static.refreshLog);
    setText('btnOpenDebugLogFile', UI_TEXT.static.openDebugLogFile);
    setText('storageCardTitle', UI_TEXT.static.storageCardTitle);
    setText('btnRefreshStorage', UI_TEXT.static.storageRefresh);
    setText('cleanupTitle', UI_TEXT.static.cleanupTitle);
    setText('cleanupIntro', UI_TEXT.static.cleanupIntro);
    setText('autoCleanupEnabledLabel', UI_TEXT.static.cleanupEnabledLabel);
    setText('autoCleanupDaysLabel', UI_TEXT.static.cleanupDaysLabel);
    setText('autoCleanupTargetLabel', UI_TEXT.static.cleanupTargetLabel);
    setText('autoCleanupTargetLive', UI_TEXT.static.cleanupTargetLive);
    setText('autoCleanupTargetAll', UI_TEXT.static.cleanupTargetAll);
    setText('autoCleanupActionLabel', UI_TEXT.static.cleanupActionLabel);
    setText('autoCleanupActionArchive', UI_TEXT.static.cleanupActionArchive);
    setText('autoCleanupActionDelete', UI_TEXT.static.cleanupActionDelete);
    setText('btnCleanupDryRun', UI_TEXT.static.cleanupDryRun);
    setText('btnCleanupRunNow', UI_TEXT.static.cleanupRunNow);
    setText('discordCardTitle', UI_TEXT.static.discordCardTitle);
    setText('discordWebhookUrlLabel', UI_TEXT.static.discordWebhookUrlLabel);
    setText('discordNotifyLiveStartLabel', UI_TEXT.static.discordNotifyLiveStartLabel);
    setText('discordNotifyLiveEndLabel', UI_TEXT.static.discordNotifyLiveEndLabel);
    setText('discordNotifyVodCompleteLabel', UI_TEXT.static.discordNotifyVodCompleteLabel);
    setText('autoResumeLiveRecordingLabel', UI_TEXT.static.autoResumeLiveRecordingLabel);
    setText('autoMergeResumedPartsLabel', UI_TEXT.static.autoMergeResumedPartsLabel);
    setText('deletePartsAfterMergeLabel', UI_TEXT.static.deletePartsAfterMergeLabel);
    setText('discordNotifyVodAutoQueuedLabel', UI_TEXT.static.discordNotifyVodAutoQueuedLabel);
    setText('autoVodCardTitle', UI_TEXT.static.autoVodCardTitle);
    setText('autoVodPollMinutesLabel', UI_TEXT.static.autoVodPollMinutesLabel);
    setText('autoVodMaxAgeHoursLabel', UI_TEXT.static.autoVodMaxAgeHoursLabel);
    setText('btnAutoVodScanNow', UI_TEXT.static.autoVodScanNow);
    setText('btnAutoRecordScanNow', UI_TEXT.static.autoRecordScanNow);

    // Empty-state copy for the VODs grid (when no streamer is selected
    // yet) and the Merge file list (no files added yet). Both were
    // hardcoded German in the HTML — English users saw German strings.
    syncVodSelectionState();
    setText('mergeEmptyText', UI_TEXT.merge.empty);

    // Localize the modal close-button aria-label. The buttons share a
    // .modal-close-localizable class so one call updates all five.
    setAriaLabelAll('.modal-close-localizable', UI_TEXT.streamers.modalCloseAria);
    document.getElementById('cutProgressGauge')?.setAttribute('aria-label', UI_TEXT.streamers.cutProgressAria);
    document.getElementById('mergeProgressGauge')?.setAttribute('aria-label', UI_TEXT.streamers.mergeProgressAria);
    document.getElementById('updateProgressGauge')?.setAttribute('aria-label', UI_TEXT.streamers.updateProgressAria);
    setText('clipsDiscoverButton', currentLanguage === 'de' ? 'Clips suchen' : 'Find clips');
    setText('backupCardTitle', UI_TEXT.static.backupCardTitle);
    setText('btnCreateBackup', UI_TEXT.static.backupCreate);
    setText('btnRestoreBackup', UI_TEXT.static.backupRestore);
    setText('backupScopeText', UI_TEXT.static.backupScope);
    setText('backupSettingsOnly', UI_TEXT.static.backupSettingsOnly);
    setText('btnExportConfig', UI_TEXT.static.exportConfig);
    setText('btnImportConfig', UI_TEXT.static.importConfig);
    setText('btnResetDownloadedIds', UI_TEXT.static.resetDownloadedIds);
    setText('vodHideDownloadedText', UI_TEXT.vods.hideDownloaded);
    setTitle('vodHideDownloadedLabel', UI_TEXT.vods.hideDownloadedTitle);
    setText('autoRefreshText', UI_TEXT.static.autoRefresh);
    setText('runtimeMetricsTitle', UI_TEXT.static.runtimeMetricsTitle);
    setText('btnRefreshMetrics', UI_TEXT.static.runtimeMetricsRefresh);
    setText('btnExportMetrics', UI_TEXT.static.runtimeMetricsExport);
    setText('runtimeMetricsAutoRefreshText', UI_TEXT.static.runtimeMetricsAutoRefresh);
    setText('runtimeMetricsOutput', UI_TEXT.static.runtimeMetricsLoading);
    setText('updateText', UI_TEXT.static.checkUpdates);
    setText('updateButton', UI_TEXT.updates.downloadNow);
    setText('workspaceUpdateLater', UI_TEXT.updates.later);
    setText('workspaceUpdateDismissText', UI_TEXT.updates.dismissAria);
    setAriaLabel('workspaceUpdateDismiss', UI_TEXT.updates.dismissAria);
    setTitle('workspaceUpdateDismiss', UI_TEXT.updates.dismissAria);
    setText('updateModalEyebrow', UI_TEXT.static.updateTitle);
    setText('updateModalTitle', UI_TEXT.updates.modalAvailableTitle);
    setText('updateModalDismissBtn', UI_TEXT.updates.modalDismiss);
    setText('updateModalConfirmBtn', UI_TEXT.updates.modalDownloadConfirm);
    setText('updateModalSkipBtn', UI_TEXT.updates.modalSkipVersion);
    setText('updateChangelogLabel', UI_TEXT.updates.changelogLabel);
    setText('updateChangelogToggle', UI_TEXT.updates.showChangelog);
    setText('updateChangelogEmpty', UI_TEXT.updates.noChangelog);
    setPlaceholder('newStreamer', UI_TEXT.static.streamerPlaceholder);
    setAriaLabel('newStreamer', UI_TEXT.static.streamerAddAriaLabel);
    setPlaceholder('vodFilterInput', UI_TEXT.vods.filterPlaceholder);
    setAriaLabel('vodFilterInput', UI_TEXT.vods.filterAria);
    setTitle('vodFilterClearBtn', UI_TEXT.vods.filterClearTitle);
    setAriaLabel('vodFilterClearBtn', UI_TEXT.vods.filterClearTitle);
    setPlaceholder('chatViewerFilter', UI_TEXT.queue.chatViewerFilterPlaceholder);
    setAriaLabel('chatViewerFilter', UI_TEXT.queue.chatViewerFilterAria);
    setPlaceholder('settingsSearchInput', UI_TEXT.static.settingsSearchPlaceholder);
    setAriaLabel('settingsSearchInput', UI_TEXT.static.settingsSearchPlaceholder);
    setAriaLabel('systemStatusButton', UI_TEXT.static.systemStatus);
    setTitle('systemStatusButton', UI_TEXT.static.systemStatus);
    setAriaLabel('openSettingsButton', UI_TEXT.static.openSettings);
    setTitle('openSettingsButton', UI_TEXT.static.openSettings);
    setAriaLabel('toolbarRefreshVodsBtn', UI_TEXT.static.refreshVods);
    setTitle('toolbarRefreshVodsBtn', UI_TEXT.static.refreshVods);
    setAriaLabel('toolbarClipDownloadBtn', UI_TEXT.static.downloadClip);
    setTitle('toolbarClipDownloadBtn', UI_TEXT.static.downloadClip);
    setAriaLabel('toolbarCheckUpdateBtn', UI_TEXT.static.checkUpdates);
    setTitle('toolbarCheckUpdateBtn', UI_TEXT.static.checkUpdates);
    setText('autoVodRulesBtn', currentLanguage === 'de' ? 'Kanalregeln' : 'Channel rules');
    setText('vodMarkersButton', currentLanguage === 'de' ? 'Markierungen' : 'Markers');
    setText('vodLibraryButton', RendererVodLibrary.groupName() || (currentLanguage === 'de' ? 'Ansichten' : 'Views'));
    setText('vodSortLabel', UI_TEXT.vods.sortLabel);
    if (typeof refreshVodSortSelectLabels === 'function') {
        refreshVodSortSelectLabels();
    }
    setText('vodBulkAddBtn', UI_TEXT.vods.bulkAddToQueue);
    setText('vodBulkMarkBtn', UI_TEXT.vods.bulkMarkDownloaded);
    setText('vodBulkUnmarkBtn', UI_TEXT.vods.bulkUnmark);
    setText('vodBulkClearBtn', UI_TEXT.vods.bulkClear);
    if (typeof updateVodBulkBar === 'function') {
        // Repopulate the count text in the new locale
        updateVodBulkBar();
    }

    const status = document.getElementById('statusText')?.textContent?.trim() || '';
    if (status === UI_TEXTS.de.static.notConnected || status === UI_TEXTS.en.static.notConnected) {
        setText('statusText', UI_TEXT.static.notConnected);
    }

    const guideRefresh = (window as unknown as { refreshTemplateGuideTexts?: () => void }).refreshTemplateGuideTexts;
    if (typeof guideRefresh === 'function') {
        guideRefresh();
    }

    const updateRefresh = (window as unknown as { refreshUpdateUiTexts?: () => void }).refreshUpdateUiTexts;
    if (typeof updateRefresh === 'function') {
        updateRefresh();
    }

    const activeTabId = document.querySelector('.tab-content.active')?.id || 'vodsTab';
    const workspaceSync = (window as unknown as { syncWorkspaceChrome?: (tab: string) => void }).syncWorkspaceChrome;
    if (typeof workspaceSync === 'function') {
        workspaceSync(activeTabId.replace(/Tab$/, ''));
    }
    if (typeof refreshEditingWorkflowLanguage === 'function') refreshEditingWorkflowLanguage();
    if (typeof refreshCutterLocalizedUi === 'function') refreshCutterLocalizedUi();
    if (typeof renderCutterEditor === 'function') renderCutterEditor();
}

function localizeCurrentStatusText(current: string): string {
    const map: Record<string, keyof typeof UI_TEXT.status> = {
        [UI_TEXTS.de.status.noLogin]: 'noLogin',
        [UI_TEXTS.en.status.noLogin]: 'noLogin',
        [UI_TEXTS.de.status.connecting]: 'connecting',
        [UI_TEXTS.en.status.connecting]: 'connecting',
        [UI_TEXTS.de.status.connected]: 'connected',
        [UI_TEXTS.en.status.connected]: 'connected',
        [UI_TEXTS.de.status.connectFailedPublic]: 'connectFailedPublic',
        [UI_TEXTS.en.status.connectFailedPublic]: 'connectFailedPublic'
    };

    const key = map[current];
    return key ? UI_TEXT.status[key] : current;
}
