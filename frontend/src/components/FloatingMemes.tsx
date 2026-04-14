const MEMES = [
  { src: "/memes/pepe.png",          w: 90,  x: "5%",   y: "12%",  duration: 35, delay: 0,   dx: 50,  dy: -40, dx2: -30, dy2: 60,  rot: -4,  rot2: 4,  scale: 0.95, opacity: 0.06, glitchDelay: 3 },
  { src: "/memes/doge.jpg",          w: 70,  x: "82%",  y: "8%",   duration: 28, delay: 4,   dx: -40, dy: 50,  dx2: 30,  dy2: -40, rot: 3,   rot2: -3, scale: 0.85, opacity: 0.05, glitchDelay: 5 },
  { src: "/memes/wojak.webp",        w: 65,  x: "15%",  y: "55%",  duration: 32, delay: 8,   dx: 30,  dy: -70, dx2: -20, dy2: 40,  rot: -2,  rot2: 5,  scale: 0.8,  opacity: 0.05, glitchDelay: 2 },
  { src: "/memes/HODL.jpg",          w: 80,  x: "75%",  y: "40%",  duration: 40, delay: 2,   dx: -60, dy: -30, dx2: 40,  dy2: 50,  rot: 5,   rot2: -2, scale: 0.9,  opacity: 0.06, glitchDelay: 7 },
  { src: "/memes/tung-tung.jpg",     w: 60,  x: "45%",  y: "75%",  duration: 25, delay: 12,  dx: 40,  dy: 30,  dx2: -50, dy2: -20, rot: -3,  rot2: 3,  scale: 0.85, opacity: 0.05, glitchDelay: 4 },
  { src: "/memes/67-kid.jpg",        w: 75,  x: "90%",  y: "65%",  duration: 33, delay: 6,   dx: -50, dy: -50, dx2: 30,  dy2: 30,  rot: 2,   rot2: -4, scale: 0.88, opacity: 0.05, glitchDelay: 6 },
  { src: "/memes/neet.jpg",          w: 55,  x: "3%",   y: "85%",  duration: 30, delay: 15,  dx: 60,  dy: -20, dx2: -40, dy2: 40,  rot: -5,  rot2: 2,  scale: 0.8,  opacity: 0.04, glitchDelay: 1 },
  { src: "/memes/scuba.jpeg",        w: 70,  x: "55%",  y: "20%",  duration: 36, delay: 10,  dx: -30, dy: 60,  dx2: 50,  dy2: -30, rot: 3,   rot2: -3, scale: 0.85, opacity: 0.05, glitchDelay: 8 },
  { src: "/memes/troll.avif",        w: 50,  x: "30%",  y: "35%",  duration: 27, delay: 18,  dx: 40,  dy: -40, dx2: -30, dy2: 50,  rot: -2,  rot2: 4,  scale: 0.75, opacity: 0.04, glitchDelay: 3 },
  { src: "/memes/zoomer.avif",       w: 65,  x: "68%",  y: "82%",  duration: 34, delay: 7,   dx: -40, dy: -60, dx2: 40,  dy2: 20,  rot: 4,   rot2: -2, scale: 0.82, opacity: 0.05, glitchDelay: 5 },
  { src: "/memes/what-the-dog.jpeg", w: 60,  x: "20%",  y: "15%",  duration: 29, delay: 20,  dx: 50,  dy: 40,  dx2: -40, dy2: -30, rot: -3,  rot2: 3,  scale: 0.8,  opacity: 0.04, glitchDelay: 9 },
  { src: "/memes/doorbell-chud.jpg", w: 75,  x: "88%",  y: "25%",  duration: 38, delay: 14,  dx: -60, dy: 30,  dx2: 30,  dy2: -50, rot: 2,   rot2: -5, scale: 0.9,  opacity: 0.05, glitchDelay: 2 },
  { src: "/memes/abcdefg.jpeg",      w: 85,  x: "40%",  y: "50%",  duration: 42, delay: 5,   dx: 30,  dy: -50, dx2: -40, dy2: 40,  rot: -4,  rot2: 4,  scale: 0.92, opacity: 0.05, glitchDelay: 6 },
  { src: "/memes/Autism-Logo.png",   w: 50,  x: "60%",  y: "5%",   duration: 26, delay: 22,  dx: -30, dy: 40,  dx2: 50,  dy2: -20, rot: 3,   rot2: -2, scale: 0.75, opacity: 0.04, glitchDelay: 4 },
];

export function FloatingMemes() {
  return (
    <div className="meme-float-layer">
      {MEMES.map((m, i) => (
        <div
          key={i}
          className="meme-float"
          style={{
            left: m.x,
            top: m.y,
            width: m.w,
            height: m.w,
            backgroundImage: `url(${m.src})`,
            backgroundSize: "cover",
            backgroundPosition: "center",
            "--duration": `${m.duration}s`,
            "--delay": `${m.delay}s`,
            "--dx": `${m.dx}px`,
            "--dy": `${m.dy}px`,
            "--dx2": `${m.dx2}px`,
            "--dy2": `${m.dy2}px`,
            "--rot-start": `${m.rot}deg`,
            "--rot-end": `${m.rot2}deg`,
            "--scale": m.scale,
            "--peak-opacity": m.opacity,
            "--glitch-delay": `${m.glitchDelay}s`,
          } as React.CSSProperties}
        />
      ))}
    </div>
  );
}
