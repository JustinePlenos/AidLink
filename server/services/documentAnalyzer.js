import crypto from 'node:crypto';
import sharp from 'sharp';

export const allowedDocumentTypes = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
]);

export const deterministicDocumentAnalyzer = {
  id: 'aidlink-deterministic-quality',
  kind: 'deterministic',
  version: 'aidlink-document-quality-v3',
  confidenceThreshold: null,
  capabilities: [
    'file_validity',
    'format_validation',
    'resolution',
    'brightness',
    'glare',
    'blur',
    'document_boundaries',
    'orientation',
  ],
  async analyze({ file, requestedType, analyzedAt }) {
    const issues = [];
    const warnings = [];
    const detectedMime = detectedDocumentMime(file.buffer);
    const checks = {
      supportedFormat:
        allowedDocumentTypes.has(file.mimetype) &&
        detectedMime === file.mimetype,
      validFileContents: Boolean(detectedMime),
      validFileSize: file.size > 0 && file.size <= 10 * 1024 * 1024,
    };
    let imageQuality = null;

    if (!checks.supportedFormat) {
      addQualityIssue(
        issues,
        qualityIssue(
          detectedMime ? 'format_mismatch' : 'unsupported_or_corrupt_format',
          detectedMime
            ? 'The file contents do not match the selected file format.'
            : 'The file is not a readable PDF, JPG, or PNG document.',
          'Export the original document again as PDF, JPG, or PNG, then select the new file.',
        ),
      );
    }
    if (!checks.validFileSize) {
      addQualityIssue(
        issues,
        qualityIssue(
          'invalid_file_size',
          file.size <= 0
            ? 'The file is empty or corrupt.'
            : 'The file is larger than 10 MB.',
          file.size <= 0
            ? 'Open the original file to confirm it works, then export or scan it again.'
            : 'Reduce the file size while keeping the text readable.',
        ),
      );
    }

    if (detectedMime === 'application/pdf') {
      const tail = file.buffer
        .subarray(Math.max(0, file.buffer.length - 2048))
        .toString('latin1');
      checks.validFileContents =
        file.buffer.length >= 8 && tail.includes('%%EOF');
      if (!checks.validFileContents) {
        addQualityIssue(
          issues,
          qualityIssue(
            'corrupt_file',
            'The PDF is incomplete or corrupt and cannot be read safely.',
            'Open the original PDF, export a fresh copy, and upload the new file.',
          ),
        );
      }
    } else if (detectedMime?.startsWith('image/')) {
      try {
        imageQuality = await inspectImage(file.buffer);
        checks.minimumDimensions =
          imageQuality.dimensions.width >= 600 &&
          imageQuality.dimensions.height >= 400;
        checks.orientation = imageQuality.orientation.valid;
        checks.brightness = imageQuality.brightness.value >= 40;
        checks.glare = imageQuality.glare.percentage < 18;
        checks.blur = imageQuality.blur.score >= 60;
        checks.documentBoundaries = imageQuality.documentBoundaries.complete;

        if (!checks.minimumDimensions) {
          addQualityIssue(
            issues,
            qualityIssue(
              'low_resolution',
              `The image resolution is only ${imageQuality.dimensions.width} × ${imageQuality.dimensions.height} pixels, so its text may be unreadable.`,
              'Retake or rescan the whole document at 600 × 400 pixels or higher.',
            ),
          );
        }
        if (!checks.brightness) {
          addQualityIssue(
            issues,
            qualityIssue(
              'very_low_brightness',
              'The document image is too dark to read reliably.',
              'Retake it in bright, even lighting and avoid casting a shadow over the page.',
            ),
          );
        }
        if (!checks.glare) {
          addQualityIssue(
            issues,
            qualityIssue(
              'excessive_glare',
              `Excessive glare covers about ${imageQuality.glare.percentage}% of the image.`,
              'Move away from direct light or disable flash, then retake the document straight on.',
            ),
          );
        }
        if (!checks.blur) {
          addQualityIssue(
            issues,
            qualityIssue(
              'excessive_blur',
              'The document image is too blurry to read reliably.',
              'Steady the phone, tap to focus on the text, and retake the photo.',
            ),
          );
        }
        if (!checks.documentBoundaries) {
          addQualityIssue(
            issues,
            qualityIssue(
              'incomplete_boundaries',
              'The document appears severely cropped or cut off at the image boundaries.',
              'Retake the photo with all four corners and the complete page visible.',
            ),
          );
        }
        if (!checks.orientation) {
          warnings.push(
            'The image orientation metadata is unusual. Rotate the document upright before submission if the preview is sideways.',
          );
        }
        if (checks.brightness && imageQuality.brightness.value < 70) {
          warnings.push(
            'The image is somewhat dark. Brighter, even lighting may make review easier.',
          );
        }
        if (checks.glare && imageQuality.glare.percentage >= 10) {
          warnings.push(
            'Some glare is visible. Move away from direct light if it covers important text.',
          );
        }
        if (checks.blur && imageQuality.blur.score < 120) {
          warnings.push(
            'The image is slightly soft. Make sure all names, dates, and amounts remain readable.',
          );
        }
        if (
          checks.minimumDimensions &&
          (imageQuality.dimensions.width < 1000 ||
            imageQuality.dimensions.height < 700)
        ) {
          warnings.push(
            'The image passed the minimum resolution, but a higher-resolution scan may be easier to review.',
          );
        }
        if (
          checks.documentBoundaries &&
          imageQuality.documentBoundaries.clippingRatio >= 18
        ) {
          warnings.push(
            'The page is close to the image edge. Confirm that all four corners and every line are visible.',
          );
        }
      } catch {
        checks.validFileContents = false;
        addQualityIssue(
          issues,
          qualityIssue(
            'corrupt_file',
            'The image contents are corrupt or cannot be decoded.',
            'Open the original image to confirm it works, then retake or export it as a new JPG or PNG.',
          ),
        );
      }
    }

    return {
      accepted: issues.length === 0,
      documentType: requestedType,
      fileName: file.originalname,
      issues,
      warnings: [...new Set(warnings)],
      checks,
      imageQuality,
      orientation: imageQuality?.orientation?.label || 'not_applicable',
      analyzedAt,
      confidence: null,
      classification: null,
      missingPages: null,
      likelyUnreadableText: null,
      explanations: [],
      requiresHumanReview: false,
      humanReviewReasons: [],
    };
  },
};

let activeAnalyzer = deterministicDocumentAnalyzer;

export function setDocumentAnalyzer(analyzer) {
  if (!analyzer) {
    activeAnalyzer = deterministicDocumentAnalyzer;
    return;
  }
  if (
    !String(analyzer.id || '').trim() ||
    !String(analyzer.version || '').trim() ||
    !['deterministic', 'ai', 'hybrid'].includes(analyzer.kind) ||
    typeof analyzer.analyze !== 'function'
  ) {
    throw new TypeError(
      'A document analyzer requires id, version, kind, and an async analyze function.',
    );
  }
  activeAnalyzer = {
    confidenceThreshold: analyzer.kind === 'deterministic' ? null : 0.8,
    capabilities: [],
    ...analyzer,
  };
}

export function getDocumentAnalyzerMetadata() {
  return {
    id: activeAnalyzer.id,
    kind: activeAnalyzer.kind,
    version: activeAnalyzer.version,
    confidenceThreshold: activeAnalyzer.confidenceThreshold,
    capabilities: [...(activeAnalyzer.capabilities || [])],
  };
}

export async function analyzeDocument(file, requestedType) {
  const analyzedAt = new Date().toISOString();
  const raw = await activeAnalyzer.analyze({
    file,
    requestedType,
    analyzedAt,
    privacy: {
      retainInput: false,
      retainDerivedImages: false,
      purpose: 'technical_document_review',
    },
  });
  const issues = normalizeIssues(raw?.issues);
  const warnings = normalizeStrings(raw?.warnings);
  const explanations = normalizeStrings(raw?.explanations);
  const confidence = Number.isFinite(raw?.confidence)
    ? Math.max(0, Math.min(1, Number(raw.confidence)))
    : null;
  const threshold =
    activeAnalyzer.kind === 'deterministic'
      ? null
      : Number(activeAnalyzer.confidenceThreshold ?? 0.8);
  const lowConfidence =
    threshold !== null && (confidence === null || confidence < threshold);
  const advisoryFlag =
    raw?.missingPages?.detected === true ||
    raw?.likelyUnreadableText?.detected === true;
  const requiresHumanReview =
    raw?.requiresHumanReview === true || lowConfidence || advisoryFlag;
  const humanReviewReasons = [
    ...normalizeStrings(raw?.humanReviewReasons),
    ...(lowConfidence
      ? [
          confidence === null
            ? 'Analyzer confidence was not available.'
            : `Analyzer confidence ${confidence.toFixed(2)} is below the ${threshold.toFixed(2)} review threshold.`,
        ]
      : []),
    ...(raw?.missingPages?.detected === true
      ? ['The analyzer indicated that pages may be missing.']
      : []),
    ...(raw?.likelyUnreadableText?.detected === true
      ? ['The analyzer indicated that some text may be unreadable.']
      : []),
  ];
  if (requiresHumanReview) {
    warnings.push(
      'Automated analysis could not reach high confidence. A Case Worker must review this document.',
    );
  }
  const accepted = raw?.accepted === true && issues.length === 0;
  return {
    ...raw,
    accepted,
    decision: accepted
      ? requiresHumanReview
        ? 'human_review_required'
        : 'accepted'
      : 'replace_required',
    documentType: String(raw?.documentType || requestedType),
    fileName: String(raw?.fileName || file.originalname),
    issues,
    warnings: [...new Set(warnings)],
    explanations,
    confidence,
    requiresHumanReview,
    humanReviewReasons: [...new Set(humanReviewReasons)],
    orientation: String(raw?.orientation || 'not_applicable'),
    analyzer: getDocumentAnalyzerMetadata(),
    analyzerVersion: activeAnalyzer.version,
    analyzedAt,
    sha256: crypto.createHash('sha256').update(file.buffer).digest('hex'),
    authenticityVerified: false,
    eligibilityDetermined: false,
    retention: {
      inputBufferRetainedByAnalyzer: false,
      derivedImagesRetainedByAnalyzer: false,
      policy: 'process_in_memory_discard_after_analysis',
    },
  };
}

export function disposeDocumentBuffer(file) {
  if (!file?.buffer || !Buffer.isBuffer(file.buffer)) return;
  file.buffer.fill(0);
  file.buffer = Buffer.alloc(0);
}

function detectedDocumentMime(buffer) {
  if (
    buffer.length >= 4 &&
    buffer.subarray(0, 4).equals(Buffer.from([0x25, 0x50, 0x44, 0x46]))
  ) {
    return 'application/pdf';
  }
  if (
    buffer.length >= 8 &&
    buffer
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return 'image/png';
  }
  if (
    buffer.length >= 3 &&
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff
  ) {
    return 'image/jpeg';
  }
  return '';
}

function qualityIssue(code, message, fix) {
  return { code, message, fix };
}

function addQualityIssue(issues, issue) {
  if (!issues.some((item) => item.code === issue.code)) issues.push(issue);
}

function normalizeStrings(value) {
  return Array.isArray(value)
    ? value.map((item) => String(item).trim()).filter(Boolean).slice(0, 20)
    : [];
}

function normalizeIssues(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => item && typeof item === 'object')
    .map((item) => ({
      code: String(item.code || 'quality_issue').slice(0, 80),
      message: String(item.message || 'The document needs review.').slice(0, 500),
      fix: String(item.fix || 'Replace the document with a clearer, complete copy.').slice(0, 500),
    }))
    .slice(0, 20);
}

async function inspectImage(buffer) {
  let pixels;
  try {
    const image = sharp(buffer, { failOn: 'error' });
    const metadata = await image.metadata();
    const stats = await image.stats();
    pixels = await image
      .resize({ width: 256, height: 256, fit: 'inside' })
      .greyscale()
      .raw()
      .toBuffer({ resolveWithObject: true });
    let glarePixels = 0;
    const laplacianValues = [];
    for (let index = 0; index < pixels.data.length; index += 1) {
      const pixel = pixels.data[index];
      if (pixel >= 250) glarePixels += 1;
    }
    const sampleWidth = pixels.info.width;
    const sampleHeight = pixels.info.height;
    for (let y = 1; y < sampleHeight - 1; y += 1) {
      for (let x = 1; x < sampleWidth - 1; x += 1) {
        const index = y * sampleWidth + x;
        laplacianValues.push(
          4 * pixels.data[index] -
            pixels.data[index - 1] -
            pixels.data[index + 1] -
            pixels.data[index - sampleWidth] -
            pixels.data[index + sampleWidth],
        );
      }
    }
    const laplacianMean =
      laplacianValues.reduce((sum, value) => sum + value, 0) /
      Math.max(laplacianValues.length, 1);
    const blurScore =
      laplacianValues.reduce(
        (sum, value) => sum + (value - laplacianMean) ** 2,
        0,
      ) / Math.max(laplacianValues.length, 1);
    let clippedBoundarySamples = 0;
    let boundarySamples = 0;
    const compareBoundary = (edgeIndex, innerIndex) => {
      boundarySamples += 1;
      if (Math.abs(pixels.data[edgeIndex] - pixels.data[innerIndex]) > 45) {
        clippedBoundarySamples += 1;
      }
    };
    for (let x = 0; x < sampleWidth; x += 1) {
      compareBoundary(x, Math.min(3, sampleHeight - 1) * sampleWidth + x);
      compareBoundary(
        (sampleHeight - 1) * sampleWidth + x,
        Math.max(0, sampleHeight - 4) * sampleWidth + x,
      );
    }
    for (let y = 0; y < sampleHeight; y += 1) {
      compareBoundary(
        y * sampleWidth,
        y * sampleWidth + Math.min(3, sampleWidth - 1),
      );
      compareBoundary(
        y * sampleWidth + sampleWidth - 1,
        y * sampleWidth + Math.max(0, sampleWidth - 4),
      );
    }
    const brightness =
      stats.channels.reduce((total, channel) => total + channel.mean, 0) /
      stats.channels.length;
    const width = metadata.width || 0;
    const height = metadata.height || 0;
    const boundaryClippingRatio =
      clippedBoundarySamples / Math.max(boundarySamples, 1);
    const orientationValue = metadata.orientation || 1;
    const swapsDimensions = [5, 6, 7, 8].includes(orientationValue);
    const orientedWidth = swapsDimensions ? height : width;
    const orientedHeight = swapsDimensions ? width : height;
    return {
      dimensions: { width, height },
      orientation: {
        value: orientationValue,
        label: orientedWidth > orientedHeight ? 'landscape' : 'portrait',
        valid: orientationValue >= 1 && orientationValue <= 8,
      },
      brightness: { value: Number(brightness.toFixed(1)) },
      glare: {
        percentage: Number(
          ((glarePixels / pixels.data.length) * 100).toFixed(1),
        ),
      },
      blur: { score: Number(blurScore.toFixed(1)) },
      documentBoundaries: {
        clippingRatio: Number((boundaryClippingRatio * 100).toFixed(1)),
        complete: boundaryClippingRatio < 0.3,
        note: 'Automated edge check; document completeness remains subject to human review.',
      },
    };
  } finally {
    pixels?.data?.fill(0);
  }
}
