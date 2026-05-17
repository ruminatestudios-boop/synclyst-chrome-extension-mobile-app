"use client";

import React, { useState, useEffect, useMemo, useRef } from "react";
import Link from "next/link";
import {
  motion,
  useTransform,
  useSpring,
  useMotionValue,
} from "motion/react";

export type AnimationPhase = "scatter" | "line" | "circle" | "bottom-strip";

interface FlipCardProps {
  src: string;
  index: number;
  total: number;
  phase: AnimationPhase;
  target: {
    x: number;
    y: number;
    rotation: number;
    scale: number;
    opacity: number;
  };
}

const IMG_WIDTH = 60;
const IMG_HEIGHT = 85;

function FlipCard({ src, index, total, phase, target }: FlipCardProps) {
  return (
    <motion.div
      animate={{
        x: target.x,
        y: target.y,
        rotate: target.rotation,
        scale: target.scale,
        opacity: target.opacity,
      }}
      transition={{
        type: "spring",
        stiffness: 40,
        damping: 15,
      }}
      style={{
        position: "absolute",
        width: IMG_WIDTH,
        height: IMG_HEIGHT,
        transformStyle: "preserve-3d",
        perspective: "1000px",
      }}
      className="cursor-pointer group"
    >
      <motion.div
        className="relative h-full w-full"
        style={{ transformStyle: "preserve-3d" }}
        transition={{
          duration: 0.6,
          type: "spring",
          stiffness: 260,
          damping: 20,
        }}
        whileHover={{ rotateY: 180 }}
      >
        <div
          className="absolute inset-0 h-full w-full overflow-hidden rounded-xl shadow-lg bg-zinc-200"
          style={{ backfaceVisibility: "hidden" }}
        >
          <img
            src={src}
            alt={`listing-${index}`}
            className="h-full w-full object-cover"
          />
          <div className="absolute inset-0 bg-black/10 transition-colors group-hover:bg-transparent" />
        </div>
        <div
          className="absolute inset-0 h-full w-full overflow-hidden rounded-xl shadow-lg bg-zinc-900 flex flex-col items-center justify-center p-4 border border-zinc-700"
          style={{
            backfaceVisibility: "hidden",
            transform: "rotateY(180deg)",
          }}
        >
          <div className="text-center">
            <p className="text-[8px] font-bold text-blue-400 uppercase tracking-widest mb-1">
              View
            </p>
            <p className="text-xs font-medium text-white">Details</p>
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
}

const TOTAL_IMAGES = 20;
const MAX_SCROLL = 3000;

// Product / listing style Unsplash images
const IMAGES = [
  "https://images.unsplash.com/photo-1523275335684-37898b6baf30?w=300&q=80",
  "https://images.unsplash.com/photo-1572635196237-14b3f281503f?w=300&q=80",
  "https://images.unsplash.com/photo-1560343090-f0409e92791a?w=300&q=80",
  "https://images.unsplash.com/photo-1585386959984-a4155224a1ad?w=300&q=80",
  "https://images.unsplash.com/photo-1584917865442-de89df76afd3?w=300&q=80",
  "https://images.unsplash.com/photo-1591561954557-26941169b49e?w=300&q=80",
  "https://images.unsplash.com/photo-1617127365659-c47fa864d8bc?w=300&q=80",
  "https://images.unsplash.com/photo-1542291026-7eec264c27ff?w=300&q=80",
  "https://images.unsplash.com/photo-1606107557195-0e29a4b5b4aa?w=300&q=80",
  "https://images.unsplash.com/photo-1581655353564-df123a1eb820?w=300&q=80",
  "https://images.unsplash.com/photo-1603487742131-4160ec999306?w=300&q=80",
  "https://images.unsplash.com/photo-1593642632559-0c6d3fc62b89?w=300&q=80",
  "https://images.unsplash.com/photo-1505740420928-5e560c06d30e?w=300&q=80",
  "https://images.unsplash.com/photo-1526170375885-4d8ecf77b99f?w=300&q=80",
  "https://images.unsplash.com/photo-1572635196237-14b3f281503f?w=300&q=80",
  "https://images.unsplash.com/photo-1585386959984-a4155224a1ad?w=300&q=80",
  "https://images.unsplash.com/photo-1511707171634-5f897ff02aa9?w=300&q=80",
  "https://images.unsplash.com/photo-1523275335684-37898b6baf30?w=300&q=80",
  "https://images.unsplash.com/photo-1584917865442-de89df76afd3?w=300&q=80",
  "https://images.unsplash.com/photo-1560343090-f0409e92791a?w=300&q=80",
];

const lerp = (start: number, end: number, t: number) =>
  start * (1 - t) + end * t;

export default function ScrollMorphHero() {
  const [introPhase, setIntroPhase] = useState<AnimationPhase>("scatter");
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const handleResize = (entries: ResizeObserverEntry[]) => {
      for (const entry of entries) {
        setContainerSize({
          width: entry.contentRect.width,
          height: entry.contentRect.height,
        });
      }
    };
    const observer = new ResizeObserver(handleResize);
    observer.observe(containerRef.current);
    setContainerSize({
      width: containerRef.current.offsetWidth,
      height: containerRef.current.offsetHeight,
    });
    return () => observer.disconnect();
  }, []);

  const virtualScroll = useMotionValue(0);
  const scrollRef = useRef(0);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      const newScroll = Math.min(
        Math.max(scrollRef.current + e.deltaY, 0),
        MAX_SCROLL
      );
      scrollRef.current = newScroll;
      virtualScroll.set(newScroll);
    };
    let touchStartY = 0;
    const handleTouchStart = (e: TouchEvent) => {
      touchStartY = e.touches[0].clientY;
    };
    const handleTouchMove = (e: TouchEvent) => {
      const touchY = e.touches[0].clientY;
      const deltaY = touchStartY - touchY;
      touchStartY = touchY;
      const newScroll = Math.min(
        Math.max(scrollRef.current + deltaY, 0),
        MAX_SCROLL
      );
      scrollRef.current = newScroll;
      virtualScroll.set(newScroll);
    };
    container.addEventListener("wheel", handleWheel, { passive: false });
    container.addEventListener("touchstart", handleTouchStart, { passive: false });
    container.addEventListener("touchmove", handleTouchMove, { passive: false });
    return () => {
      container.removeEventListener("wheel", handleWheel);
      container.removeEventListener("touchstart", handleTouchStart);
      container.removeEventListener("touchmove", handleTouchMove);
    };
  }, [virtualScroll]);

  const morphProgress = useTransform(virtualScroll, [0, 600], [0, 1]);
  const smoothMorph = useSpring(morphProgress, { stiffness: 40, damping: 20 });
  const scrollRotate = useTransform(virtualScroll, [600, 3000], [0, 360]);
  const smoothScrollRotate = useSpring(scrollRotate, {
    stiffness: 40,
    damping: 20,
  });

  const mouseX = useMotionValue(0);
  const smoothMouseX = useSpring(mouseX, { stiffness: 30, damping: 20 });

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const handleMouseMove = (e: MouseEvent) => {
      const rect = container.getBoundingClientRect();
      const relativeX = e.clientX - rect.left;
      const normalizedX = (relativeX / rect.width) * 2 - 1;
      mouseX.set(normalizedX * 100);
    };
    container.addEventListener("mousemove", handleMouseMove);
    return () => container.removeEventListener("mousemove", handleMouseMove);
  }, [mouseX]);

  useEffect(() => {
    const t1 = setTimeout(() => setIntroPhase("line"), 500);
    const t2 = setTimeout(() => setIntroPhase("circle"), 2500);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, []);

  const scatterPositions = useMemo(
    () =>
      IMAGES.map(() => ({
        x: (Math.random() - 0.5) * 1500,
        y: (Math.random() - 0.5) * 1000,
        rotation: (Math.random() - 0.5) * 180,
        scale: 0.6,
        opacity: 0,
      })),
    []
  );

  const [morphValue, setMorphValue] = useState(0);
  const [rotateValue, setRotateValue] = useState(0);
  const [parallaxValue, setParallaxValue] = useState(0);

  useEffect(() => {
    const unMorph = smoothMorph.on("change", setMorphValue);
    const unRotate = smoothScrollRotate.on("change", setRotateValue);
    const unParallax = smoothMouseX.on("change", setParallaxValue);
    return () => {
      unMorph();
      unRotate();
      unParallax();
    };
  }, [smoothMorph, smoothScrollRotate, smoothMouseX]);

  const contentOpacity = useTransform(smoothMorph, [0.8, 1], [0, 1]);
  const contentY = useTransform(smoothMorph, [0.8, 1], [20, 0]);

  return (
    <div
      ref={containerRef}
      className="relative w-full h-full bg-white overflow-hidden"
    >
      <div className="flex h-full w-full flex-col items-center justify-center perspective-1000">
        {/* Intro text (fades out as user scrolls) */}
        <div className="absolute z-0 flex flex-col items-center justify-center text-center pointer-events-none top-1/2 -translate-y-1/2">
          <motion.div
            initial={{ opacity: 0, y: 20, filter: "blur(10px)" }}
            animate={
              introPhase === "circle" && morphValue < 0.5
                ? {
                    opacity: 1 - morphValue * 2,
                    y: 0,
                    filter: "blur(0px)",
                  }
                : { opacity: 0, filter: "blur(10px)" }
            }
            transition={{ duration: 1 }}
            className="flex flex-col items-center gap-2"
          >
            <div className="inline-flex items-center gap-2 px-4 py-1.5 mb-2 bg-zinc-100 border border-zinc-200 rounded-xl">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                className="text-zinc-500"
              >
                <path d="M12 3l1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5L12 3z" />
                <path d="M5 21l2-6 2 2 2-2-2-2 2-6" />
                <path d="M19 21l-2-6-2 2-2-2 2-2-2-6" />
              </svg>
              <p className="text-xs text-zinc-600 font-medium leading-tight text-left whitespace-nowrap max-[380px]:whitespace-normal">
                <span className="text-zinc-900 font-semibold">Smart Suggest:</span> The more you use
                it, the smarter it gets
              </p>
            </div>
            <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 md:text-4xl">
              Snap a photo. AI lists it on Shopify
            </h1>
            <motion.p
              initial={{ opacity: 0 }}
              animate={
                introPhase === "circle" && morphValue < 0.5
                  ? { opacity: 0.6 - morphValue }
                  : { opacity: 0 }
              }
              transition={{ duration: 1, delay: 0.2 }}
              className="mt-3 text-xs font-semibold tracking-widest text-zinc-500"
            >
              SCROLL TO EXPLORE
            </motion.p>
          </motion.div>
        </div>

        {/* Content when arc is formed (SyncLyst hero) */}
        <motion.div
          style={{ opacity: contentOpacity, y: contentY }}
          className="absolute top-[8%] z-10 flex flex-col items-center justify-center text-center pointer-events-none px-4"
        >
          <div className="inline-flex items-center gap-2 px-4 py-1.5 mb-6 bg-zinc-50 border border-zinc-200 rounded-xl">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              className="text-zinc-500"
            >
              <path d="M12 3l1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5L12 3z" />
            </svg>
            <p className="text-xs text-zinc-600 font-medium leading-tight text-left whitespace-nowrap max-[380px]:whitespace-normal">
              <span className="text-zinc-900 font-semibold">Smart Suggest:</span> The more you use
              it, the smarter it gets
            </p>
          </div>
          <h2 className="text-3xl md:text-5xl font-semibold text-zinc-900 tracking-tight mb-4">
            Snap a photo. AI lists it on Shopify
          </h2>
          <p className="text-sm md:text-base text-zinc-500 max-w-xl leading-relaxed mb-6">
            What used to take 20 minutes now takes one tap.
            <br />
            Everything you need to sell — title, description, price &amp; tags — done for you instantly.
          </p>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-3 pointer-events-auto">
            <Link
              href="/list"
              className="inline-flex items-center justify-center gap-2 bg-zinc-900 text-white px-6 py-3.5 rounded-xl text-sm font-medium hover:bg-zinc-800 transition-colors shadow-lg shadow-zinc-900/10"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
              >
                <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z" />
                <circle cx="12" cy="13" r="3" />
              </svg>
              SyncLyst® — List a Product
            </Link>
            <Link
              href="/landing.html"
              className="inline-flex items-center justify-center gap-2 bg-white text-zinc-900 px-6 py-3.5 rounded-xl text-sm font-medium border border-zinc-200 hover:bg-zinc-50 transition-colors"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
              >
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="17 8 12 3 7 8" />
                <line x1="12" y1="3" x2="12" y2="15" />
              </svg>
              Batch Upload
              <span className="text-xs font-semibold text-zinc-400 uppercase tracking-widest ml-1">
                Premium
              </span>
            </Link>
          </div>
        </motion.div>

        <div className="relative flex items-center justify-center w-full h-full">
          {IMAGES.slice(0, TOTAL_IMAGES).map((src, i) => {
            let target: FlipCardProps["target"] = {
              x: 0,
              y: 0,
              rotation: 0,
              scale: 1,
              opacity: 1,
            };

            if (introPhase === "scatter") {
              target = scatterPositions[i];
            } else if (introPhase === "line") {
              const lineSpacing = 70;
              const lineTotalWidth = TOTAL_IMAGES * lineSpacing;
              const lineX = i * lineSpacing - lineTotalWidth / 2;
              target = { x: lineX, y: 0, rotation: 0, scale: 1, opacity: 1 };
            } else {
              const isMobile = containerSize.width < 768;
              const minDimension = Math.min(
                containerSize.width,
                containerSize.height
              );
              const circleRadius = Math.min(minDimension * 0.35, 350);
              const circleAngle = (i / TOTAL_IMAGES) * 360;
              const circleRad = (circleAngle * Math.PI) / 180;
              const circlePos = {
                x: Math.cos(circleRad) * circleRadius,
                y: Math.sin(circleRad) * circleRadius,
                rotation: circleAngle + 90,
              };

              const baseRadius = Math.min(
                containerSize.width,
                containerSize.height * 1.5
              );
              const arcRadius = baseRadius * (isMobile ? 1.4 : 1.1);
              const arcApexY = containerSize.height * (isMobile ? 0.35 : 0.25);
              const arcCenterY = arcApexY + arcRadius;
              const spreadAngle = isMobile ? 100 : 130;
              const startAngle = -90 - spreadAngle / 2;
              const step = spreadAngle / (TOTAL_IMAGES - 1);
              const scrollProgress = Math.min(Math.max(rotateValue / 360, 0), 1);
              const maxRotation = spreadAngle * 0.8;
              const boundedRotation = -scrollProgress * maxRotation;
              const currentArcAngle = startAngle + i * step + boundedRotation;
              const arcRad = (currentArcAngle * Math.PI) / 180;
              const arcPos = {
                x: Math.cos(arcRad) * arcRadius + parallaxValue,
                y: Math.sin(arcRad) * arcRadius + arcCenterY,
                rotation: currentArcAngle + 90,
                scale: isMobile ? 1.4 : 1.8,
              };

              target = {
                x: lerp(circlePos.x, arcPos.x, morphValue),
                y: lerp(circlePos.y, arcPos.y, morphValue),
                rotation: lerp(circlePos.rotation, arcPos.rotation, morphValue),
                scale: lerp(1, arcPos.scale, morphValue),
                opacity: 1,
              };
            }

            return (
              <FlipCard
                key={i}
                src={src}
                index={i}
                total={TOTAL_IMAGES}
                phase={introPhase}
                target={target}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}
