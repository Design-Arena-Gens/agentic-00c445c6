"use client";

import NextImage from "next/image";
import { useEffect, useMemo, useState } from "react";
import { defaultSlide, duplicateSlide, Slide } from "@/lib/slides";
import { clsx } from "clsx";

type ExportState = "idle" | "preparing" | "rendering" | "saving";

const FPS = 30;
const CANVAS_WIDTH = 720;
const CANVAS_HEIGHT = 1280;

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

const easeInOutCubic = (t: number) =>
  t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

const loadImage = (dataUrl?: string) =>
  new Promise<HTMLImageElement | null>((resolve) => {
    if (!dataUrl) {
      resolve(null);
      return;
    }

    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = dataUrl;
  });

const renderWrappedText = (
  context: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  lineHeight: number,
) => {
  const words = text.split(" ");
  let line = "";
  let currentY = y;

  for (const word of words) {
    const testLine = `${line}${word} `;
    const metrics = context.measureText(testLine);
    if (metrics.width > maxWidth && line !== "") {
      context.fillText(line.trimEnd(), x, currentY);
      line = `${word} `;
      currentY += lineHeight;
    } else {
      line = testLine;
    }
  }

  if (line.trim() !== "") {
    context.fillText(line.trimEnd(), x, currentY);
  }

  return currentY + lineHeight;
};

const drawSlideFrame = (
  context: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  slide: Slide,
  image: HTMLImageElement | null,
  frameProgress: number,
) => {
  context.save();
  context.fillStyle = slide.backgroundColor;
  context.fillRect(0, 0, canvas.width, canvas.height);

  if (image) {
    const imageAspect = image.width / image.height;
    const canvasAspect = canvas.width / canvas.height;
    let renderWidth = canvas.width;
    let renderHeight = canvas.height;

    if (imageAspect > canvasAspect) {
      renderHeight = canvas.height;
      renderWidth = imageAspect * renderHeight;
    } else {
      renderWidth = canvas.width;
      renderHeight = renderWidth / imageAspect;
    }

    const offsetX = (canvas.width - renderWidth) / 2;
    const offsetY = (canvas.height - renderHeight) / 2;
    context.drawImage(image, offsetX, offsetY, renderWidth, renderHeight);
    context.fillStyle = "rgba(0, 0, 0, 0.35)";
    context.fillRect(0, 0, canvas.width, canvas.height);
  }

  const eased = easeInOutCubic(Math.min(Math.max(frameProgress, 0), 1));
  const verticalPadding = canvas.height * 0.12;
  const textAreaWidth = canvas.width * 0.85;
  const accentHeight = canvas.height * 0.0075;

  let baseY = canvas.height / 2 - verticalPadding;
  if (slide.alignment === "top") {
    baseY = verticalPadding;
  } else if (slide.alignment === "bottom") {
    baseY = canvas.height - verticalPadding * 3;
  }

  const translation = (1 - eased) * 60;
  const accentWidth = canvas.width * 0.28 * eased;

  context.save();
  context.translate(0, translation);
  context.globalAlpha = 0.8 + 0.2 * eased;

  context.fillStyle = slide.accentColor;
  context.fillRect(
    canvas.width * 0.075,
    baseY,
    Math.max(accentWidth, 1),
    accentHeight,
  );

  context.fillStyle = slide.textColor;
  context.font = `700 ${Math.floor(canvas.height * 0.07)}px "Inter", "Helvetica Neue", Arial, sans-serif`;
  context.textBaseline = "top";
  let currentY = baseY + accentHeight + canvas.height * 0.02;
  currentY = renderWrappedText(
    context,
    slide.title || "",
    canvas.width * 0.075,
    currentY,
    textAreaWidth,
    canvas.height * 0.075,
  );

  context.font = `400 ${Math.floor(canvas.height * 0.035)}px "Inter", "Helvetica Neue", Arial, sans-serif`;
  renderWrappedText(
    context,
    slide.subtitle || "",
    canvas.width * 0.075,
    currentY + canvas.height * 0.035,
    textAreaWidth,
    canvas.height * 0.05,
  );

  context.restore();
  context.restore();
};

const ensureMediaRecorder = () => {
  if (typeof window === "undefined") {
    throw new Error("MediaRecorder is only available on the client.");
  }
  if (!("MediaRecorder" in window)) {
    throw new Error(
      "MediaRecorder is not supported in this browser. Try a recent Chromium-based browser.",
    );
  }
};

const exportSlidesToVideo = async (
  slides: Slide[],
  onProgress?: (progress: number) => void,
) => {
  ensureMediaRecorder();

  if (slides.length === 0) {
    throw new Error("Add at least one slide before exporting.");
  }

  const canvas = document.createElement("canvas");
  canvas.width = CANVAS_WIDTH;
  canvas.height = CANVAS_HEIGHT;
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Unable to acquire canvas context.");
  }

  const stream = canvas.captureStream(FPS);
  const mimeCandidates = [
    "video/webm;codecs=vp9",
    "video/webm;codecs=vp8",
    "video/webm",
  ];

  let recorder: MediaRecorder | null = null;
  for (const mime of mimeCandidates) {
    if (
      typeof MediaRecorder.isTypeSupported === "function" &&
      !MediaRecorder.isTypeSupported(mime)
    ) {
      continue;
    }
    try {
      recorder = new MediaRecorder(stream, { mimeType: mime });
      break;
    } catch (error) {
      console.warn("Unable to use mime type", mime, error);
    }
  }

  if (!recorder) {
    recorder = new MediaRecorder(stream);
  }

  const totalFrames = slides.reduce(
    (acc, slide) => acc + Math.max(1, Math.round(slide.duration * FPS)),
    0,
  );

  const chunks: BlobPart[] = [];
  recorder.ondataavailable = (event) => {
    if (event.data && event.data.size > 0) {
      chunks.push(event.data);
    }
  };

  const images = await Promise.all(slides.map((slide) => loadImage(slide.imageDataUrl)));

  await new Promise<void>((resolve, reject) => {
    let capturedFrames = 0;

    recorder!.addEventListener("error", (event: Event) => {
      console.error("Recorder error", event);
      if ("error" in event) {
        const error = (event as unknown as { error?: DOMException }).error;
        reject(error ?? new Error("MediaRecorder failed."));
      } else {
        reject(new Error("MediaRecorder failed."));
      }
    });

    recorder!.addEventListener("stop", () => resolve());

    recorder!.start();

    (async () => {
      for (let index = 0; index < slides.length; index++) {
        const slide = slides[index];
        const image = images[index];
        const frameCount = Math.max(1, Math.round(slide.duration * FPS));

        for (let frame = 0; frame < frameCount; frame++) {
          const progress =
            frameCount === 1 ? 1 : frame / (frameCount - 1);
          drawSlideFrame(context, canvas, slide, image, progress);
          const videoTrack = stream.getVideoTracks()[0];
          if (videoTrack && "requestFrame" in videoTrack) {
            (videoTrack as CanvasCaptureMediaStreamTrack).requestFrame();
          }
          capturedFrames += 1;
          onProgress?.(capturedFrames / totalFrames);
          await sleep(1000 / FPS);
        }
      }

      recorder!.stop();
    })().catch((error) => {
      recorder!.stop();
      reject(error);
    });
  });

  return new Blob(chunks, { type: recorder.mimeType || "video/webm" });
};

const SlidePreview = ({
  slide,
  isActive,
}: {
  slide: Slide;
  isActive: boolean;
}) => {
  const alignmentClass =
    slide.alignment === "top"
      ? "justify-start pt-12"
      : slide.alignment === "bottom"
        ? "justify-end pb-16"
        : "justify-center";

  return (
    <div
      className={clsx(
        "relative aspect-[9/16] w-full overflow-hidden rounded-[28px] border transition duration-500",
        isActive
          ? "border-orange-400 shadow-[0_35px_70px_-35px_rgba(249,115,22,0.9)]"
          : "border-slate-800",
      )}
    >
      <div
        className="absolute inset-0 transition-all"
        style={{ backgroundColor: slide.backgroundColor }}
      />
      {slide.imageDataUrl ? (
        <>
          <NextImage
            alt=""
            src={slide.imageDataUrl}
            fill
            className="object-cover"
            sizes="(max-width: 1280px) 100vw, 380px"
            unoptimized
          />
          <div className="absolute inset-0 bg-black/50" />
        </>
      ) : null}

      <div
        className={clsx(
          "relative z-10 flex h-full w-full flex-col px-8 text-white transition-all duration-500",
          alignmentClass,
        )}
      >
        <span
          className="mb-4 h-1 rounded-full transition-all duration-500"
          style={{ backgroundColor: slide.accentColor, width: "28%" }}
        />
        <h2
          className="text-balance text-3xl font-semibold leading-tight text-white drop-shadow-lg md:text-4xl"
          style={{ color: slide.textColor }}
        >
          {slide.title || "Add a bold headline"}
        </h2>
        <p
          className="mt-4 text-sm leading-relaxed text-white/80 md:text-base"
          style={{ color: slide.textColor }}
        >
          {slide.subtitle || "Keep it short and focused for Instagram viewers."}
        </p>
      </div>
    </div>
  );
};

const SlidesPlayer = ({
  slides,
  isPlaying,
  onToggle,
}: {
  slides: Slide[];
  isPlaying: boolean;
  onToggle: () => void;
}) => {
  const [indexCounter, setIndexCounter] = useState(0);
  const [progress, setProgress] = useState(0);

  const activeIndex = slides.length
    ? ((indexCounter % slides.length) + slides.length) % slides.length
    : 0;

  useEffect(() => {
    if (!isPlaying || slides.length === 0) {
      setProgress(0);
      return;
    }

    const slide = slides[activeIndex];
    const start = performance.now();

    let rafId = requestAnimationFrame(function tick() {
      const elapsed = performance.now() - start;
      setProgress(Math.min(1, elapsed / (slide.duration * 1000)));
      if (elapsed < slide.duration * 1000) {
        rafId = requestAnimationFrame(tick);
      }
    });

    const timeoutId = setTimeout(() => {
      setIndexCounter((value) => value + 1);
      setProgress(0);
    }, slide.duration * 1000);

    return () => {
      cancelAnimationFrame(rafId);
      clearTimeout(timeoutId);
    };
  }, [activeIndex, isPlaying, slides]);

  if (slides.length === 0) {
    return (
      <div className="flex aspect-[9/16] w-full items-center justify-center rounded-[28px] border border-dashed border-slate-700 bg-slate-900/40 text-sm text-slate-400">
        Add a slide to preview your Instagram video.
      </div>
    );
  }

  const currentSlide = slides[activeIndex];

  return (
    <div className="flex w-full flex-col gap-4">
      <SlidePreview slide={currentSlide} isActive />
      <div className="flex items-center justify-between gap-3 rounded-full border border-slate-800 bg-slate-900/70 px-5 py-3">
        <button
          className="flex items-center gap-2 rounded-full bg-orange-500 px-5 py-2 text-sm font-semibold text-white transition hover:bg-orange-400"
          onClick={onToggle}
        >
          {isPlaying ? "Pause preview" : "Play preview"}
        </button>
        <div className="flex flex-1 flex-col gap-2">
          <div className="flex items-center justify-between text-xs text-slate-300">
            <span>Slide {activeIndex + 1}</span>
            <span>{currentSlide.duration.toFixed(1)}s</span>
          </div>
          <div className="relative h-2 w-full overflow-hidden rounded-full bg-slate-700">
            <span
              className="absolute inset-y-0 left-0 rounded-full bg-orange-400 transition-all"
              style={{ width: `${Math.min(progress, 1) * 100}%` }}
            />
          </div>
        </div>
      </div>
    </div>
  );
};

export default function Home() {
  const [slides, setSlides] = useState<Slide[]>(() => [defaultSlide()]);
  const [activeSlideId, setActiveSlideId] = useState<string>(
    () => slides[0]?.id ?? "",
  );
  const [isPlaying, setIsPlaying] = useState(true);
  const [exportState, setExportState] = useState<ExportState>("idle");
  const [exportProgress, setExportProgress] = useState(0);

  const activeSlide = useMemo(
    () => slides.find((slide) => slide.id === activeSlideId) ?? slides[0],
    [slides, activeSlideId],
  );

  useEffect(() => {
    if (!slides.some((slide) => slide.id === activeSlideId)) {
      setActiveSlideId(slides[0]?.id ?? "");
    }
  }, [slides, activeSlideId]);

  const updateSlide = (id: string, nextSlide: Slide) => {
    setSlides((current) =>
      current.map((slide) => (slide.id === id ? nextSlide : slide)),
    );
  };

  const handleChange = <Key extends keyof Slide>(key: Key, value: Slide[Key]) => {
    if (!activeSlide) {
      return;
    }

    updateSlide(activeSlide.id, { ...activeSlide, [key]: value });
  };

  const handleImageUpload = (file?: File) => {
    if (!file || !activeSlide) {
      return;
    }
    const reader = new FileReader();
    reader.onload = (event) => {
      const result = event.target?.result;
      if (typeof result === "string") {
        handleChange("imageDataUrl", result);
      }
    };
    reader.readAsDataURL(file);
  };

  const handleAddSlide = () => {
    const nextSlide = defaultSlide();
    setSlides((current) => [...current, nextSlide]);
    setActiveSlideId(nextSlide.id);
  };

  const handleDuplicateSlide = (id: string) => {
    setSlides((current) => {
      const index = current.findIndex((slide) => slide.id === id);
      if (index === -1) {
        return current;
      }
      const copy = duplicateSlide(current[index]);
      const next = [...current];
      next.splice(index + 1, 0, copy);
      setActiveSlideId(copy.id);
      return next;
    });
  };

  const handleRemoveSlide = (id: string) => {
    setSlides((current) => {
      if (current.length === 1) {
        return current;
      }
      const next = current.filter((slide) => slide.id !== id);
      if (activeSlideId === id) {
        setActiveSlideId(next[0]?.id ?? "");
      }
      return next;
    });
  };

  const handleReorder = (id: string, direction: "up" | "down") => {
    setSlides((current) => {
      const index = current.findIndex((slide) => slide.id === id);
      if (index === -1) {
        return current;
      }
      const targetIndex = direction === "up" ? index - 1 : index + 1;
      if (targetIndex < 0 || targetIndex >= current.length) {
        return current;
      }
      const next = [...current];
      const [item] = next.splice(index, 1);
      next.splice(targetIndex, 0, item);
      return next;
    });
  };

  const handleExport = async () => {
    try {
      setExportState("preparing");
      setExportProgress(0);
      const blob = await exportSlidesToVideo(slides, (progress) => {
        setExportState("rendering");
        setExportProgress(progress);
      });
      setExportState("saving");
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `instagram-video-${Date.now()}.webm`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      console.error(error);
      window.alert(
        error instanceof Error ? error.message : "Failed to export video.",
      );
    } finally {
      setExportState("idle");
      setExportProgress(0);
    }
  };

  return (
    <div className="flex min-h-screen flex-col bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 pb-16 text-slate-100">
      <header className="sticky top-0 z-20 border-b border-white/5 bg-slate-950/80 backdrop-blur">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between px-6 py-5">
          <div>
            <p className="text-sm uppercase tracking-[0.26em] text-orange-400">
              Reel Studio
            </p>
            <h1 className="text-xl font-semibold text-white">
              Instagram Video Creator
            </h1>
          </div>
          <div className="flex items-center gap-3">
            <button
              className="rounded-full border border-slate-700 px-4 py-2 text-sm font-medium text-slate-200 transition hover:border-slate-500 hover:text-white"
              onClick={() => setIsPlaying((value) => !value)}
            >
              {isPlaying ? "Pause preview" : "Resume preview"}
            </button>
            <button
              className={clsx(
                "flex items-center gap-2 rounded-full px-5 py-2 text-sm font-semibold transition",
                exportState === "idle"
                  ? "bg-orange-500 text-white hover:bg-orange-400"
                  : "bg-orange-500/60 text-white/80",
              )}
              onClick={handleExport}
              disabled={exportState !== "idle"}
            >
              {exportState === "idle" && "Export video"}
              {exportState === "preparing" && "Preparing assets…"}
              {exportState === "rendering" &&
                `Rendering ${(exportProgress * 100).toFixed(0)}%`}
              {exportState === "saving" && "Finishing up…"}
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-10 px-6 pt-10 lg:flex-row">
        <section className="flex w-full flex-1 flex-col gap-6">
          <SlidesPlayer
            slides={slides}
            isPlaying={isPlaying}
            onToggle={() => setIsPlaying((value) => !value)}
          />
          <div className="rounded-3xl border border-white/5 bg-slate-900/40 p-6">
            <h2 className="text-lg font-semibold text-white">Slides</h2>
            <p className="mt-1 text-sm text-slate-400">
              Drag the timeline to tell your story. Keep each scene under six
              seconds for maximum engagement.
            </p>

            <div className="mt-4 flex flex-col gap-3">
              {slides.map((slide, index) => (
                <div
                  key={slide.id}
                  className={clsx(
                    "flex items-center justify-between gap-4 rounded-2xl border px-4 py-3 transition",
                    slide.id === activeSlide?.id
                      ? "border-orange-400/80 bg-orange-400/10"
                      : "border-white/5 bg-white/5 hover:border-orange-400/40",
                  )}
                >
                  <button
                    className="flex flex-1 items-center gap-4 text-left"
                    onClick={() => setActiveSlideId(slide.id)}
                  >
                    <span className="flex h-10 w-10 flex-none items-center justify-center rounded-xl bg-white/10 text-sm font-semibold text-white">
                      {index + 1}
                    </span>
                    <span className="flex flex-col gap-1">
                      <span className="text-sm font-semibold text-white">
                        {slide.title || "Untitled slide"}
                      </span>
                      <span className="text-xs text-slate-400">
                        {slide.duration.toFixed(1)} seconds
                      </span>
                    </span>
                  </button>
                  <div className="flex flex-none items-center gap-2">
                    <button
                      className="rounded-full border border-white/10 px-3 py-1 text-xs uppercase tracking-wide text-slate-200 transition hover:border-white/40"
                      onClick={() => handleReorder(slide.id, "up")}
                    >
                      ↑
                    </button>
                    <button
                      className="rounded-full border border-white/10 px-3 py-1 text-xs uppercase tracking-wide text-slate-200 transition hover:border-white/40"
                      onClick={() => handleReorder(slide.id, "down")}
                    >
                      ↓
                    </button>
                    <button
                      className="rounded-full border border-white/10 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-orange-300 transition hover:border-orange-400"
                      onClick={() => handleDuplicateSlide(slide.id)}
                    >
                      Clone
                    </button>
                    <button
                      className="rounded-full border border-white/10 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-slate-300 transition hover:border-red-400 hover:text-red-300 disabled:cursor-not-allowed disabled:opacity-30"
                      onClick={() => handleRemoveSlide(slide.id)}
                      disabled={slides.length === 1}
                    >
                      Delete
                    </button>
                  </div>
                </div>
              ))}
            </div>

            <button
              className="mt-4 flex w-full items-center justify-center rounded-2xl border border-dashed border-orange-400/60 py-3 text-sm font-semibold text-orange-300 transition hover:border-orange-400"
              onClick={handleAddSlide}
            >
              + Add another scene
            </button>
          </div>
        </section>

        <aside className="w-full max-w-md space-y-6">
          <div className="rounded-3xl border border-white/5 bg-slate-900/40 p-6 backdrop-blur">
            <h2 className="text-lg font-semibold text-white">
              Scene settings
            </h2>
            <p className="mt-1 text-sm text-slate-400">
              Craft compelling vertical stories with bold colors, concise text,
              and energetic pacing.
            </p>

            {activeSlide ? (
              <form className="mt-6 flex flex-col gap-5">
                <label className="flex flex-col gap-2 text-sm font-medium text-slate-200">
                  Headline
                  <input
                    className="rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-white outline-none transition focus:border-orange-400"
                    value={activeSlide.title}
                    onChange={(event) =>
                      handleChange("title", event.target.value)
                    }
                    maxLength={120}
                  />
                </label>

                <label className="flex flex-col gap-2 text-sm font-medium text-slate-200">
                  Supporting copy
                  <textarea
                    className="min-h-[120px] rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-white outline-none transition focus:border-orange-400"
                    value={activeSlide.subtitle}
                    onChange={(event) =>
                      handleChange("subtitle", event.target.value)
                    }
                    maxLength={180}
                  />
                </label>

                <div className="grid gap-4 sm:grid-cols-2">
                  <label className="flex flex-col gap-2 text-sm font-medium text-slate-200">
                    Background color
                    <input
                      type="color"
                      className="h-12 w-full cursor-pointer rounded-2xl border border-white/10 bg-white/5 p-2"
                      value={activeSlide.backgroundColor}
                      onChange={(event) =>
                        handleChange("backgroundColor", event.target.value)
                      }
                    />
                  </label>

                  <label className="flex flex-col gap-2 text-sm font-medium text-slate-200">
                    Text color
                    <input
                      type="color"
                      className="h-12 w-full cursor-pointer rounded-2xl border border-white/10 bg-white/5 p-2"
                      value={activeSlide.textColor}
                      onChange={(event) =>
                        handleChange("textColor", event.target.value)
                      }
                    />
                  </label>

                  <label className="flex flex-col gap-2 text-sm font-medium text-slate-200">
                    Accent color
                    <input
                      type="color"
                      className="h-12 w-full cursor-pointer rounded-2xl border border-white/10 bg-white/5 p-2"
                      value={activeSlide.accentColor}
                      onChange={(event) =>
                        handleChange("accentColor", event.target.value)
                      }
                    />
                  </label>

                  <label className="flex flex-col gap-2 text-sm font-medium text-slate-200">
                    Duration (seconds)
                    <input
                      type="range"
                      min={1}
                      max={10}
                      step={0.5}
                      value={activeSlide.duration}
                      onChange={(event) =>
                        handleChange("duration", Number(event.target.value))
                      }
                    />
                    <span className="text-xs text-slate-400">
                      {activeSlide.duration.toFixed(1)} seconds
                    </span>
                  </label>
                </div>

                <label className="flex flex-col gap-2 text-sm font-medium text-slate-200">
                  Text alignment
                  <div className="grid grid-cols-3 gap-2">
                    {(
                      [
                        ["top", "Top"],
                        ["center", "Center"],
                        ["bottom", "Bottom"],
                      ] as const
                    ).map(([value, label]) => (
                      <button
                        key={value}
                        type="button"
                        onClick={() => handleChange("alignment", value)}
                        className={clsx(
                          "rounded-2xl border px-3 py-2 text-sm transition",
                          activeSlide.alignment === value
                            ? "border-orange-400 bg-orange-400/10 text-orange-200"
                            : "border-white/10 bg-white/5 text-slate-300 hover:border-orange-300/60",
                        )}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </label>

                <label className="flex flex-col gap-3 text-sm font-medium text-slate-200">
                  Background image
                  <div className="flex items-center gap-3">
                    <input
                      type="file"
                      accept="image/*"
                      onChange={(event) =>
                        handleImageUpload(event.target.files?.[0])
                      }
                      className="w-full rounded-2xl border border-dashed border-white/10 bg-white/5 px-4 py-3 text-xs text-slate-300 file:mr-4 file:rounded-xl file:border-0 file:bg-orange-500 file:px-4 file:py-2 file:text-xs file:font-semibold file:text-white"
                    />
                    {activeSlide.imageDataUrl ? (
                      <button
                        type="button"
                        className="rounded-full border border-white/10 px-3 py-2 text-xs text-slate-200 transition hover:border-red-400 hover:text-red-300"
                        onClick={() => handleChange("imageDataUrl", undefined)}
                      >
                        Remove
                      </button>
                    ) : null}
                  </div>
                  {activeSlide.imageDataUrl ? (
                    <div className="relative h-32 w-full overflow-hidden rounded-2xl">
                      <NextImage
                        src={activeSlide.imageDataUrl}
                        alt="Slide background preview"
                        fill
                        className="object-cover"
                        sizes="(max-width: 768px) 100vw, 320px"
                        unoptimized
                      />
                    </div>
                  ) : (
                    <p className="text-xs text-slate-400">
                      Add a full-bleed portrait image to boost visual interest.
                      High contrast imagery works best with bold text overlays.
                    </p>
                  )}
                </label>
              </form>
            ) : (
              <div className="mt-6 rounded-2xl border border-dashed border-white/10 p-8 text-center text-sm text-slate-400">
                Select a slide to start editing its content.
              </div>
            )}
          </div>

          <div className="rounded-3xl border border-white/5 bg-gradient-to-br from-slate-900/80 via-slate-900/40 to-slate-900/10 p-6">
            <h3 className="text-sm font-semibold uppercase tracking-[0.32em] text-orange-300">
              Tips
            </h3>
            <ul className="mt-4 space-y-3 text-sm text-slate-300">
              <li>
                Keep your headline under 45 characters so it stays readable on
                mobile screens.
              </li>
              <li>
                Match your colors with your brand palette. High contrast boosts
                retention.
              </li>
              <li>
                Layer an image behind your text for a premium look. Use the
                accent bar to highlight key words.
              </li>
              <li>
                Aim for 3–5 scenes per reel. Each should deliver one strong
                message or call-to-action.
              </li>
            </ul>
          </div>
        </aside>
      </main>
    </div>
  );
}
