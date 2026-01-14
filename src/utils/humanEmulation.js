export class HumanEmulation {
  static async randomDelay(min = 500, max = 2000) {
    const delay = Math.floor(Math.random() * (max - min + 1)) + min;
    await new Promise(resolve => setTimeout(resolve, delay));
  }

  static cubicBezier(t, p0, p1, p2, p3) {
    const u = 1 - t;
    return {
      x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
      y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y
    };
  }

  static async moveMouse(page, fromX, fromY, toX, toY) {
    const steps = 20 + Math.floor(Math.random() * 10);
    const controlPoints = [
      { x: fromX + (Math.random() - 0.5) * 50, y: fromY + (Math.random() - 0.5) * 50 },
      { x: toX + (Math.random() - 0.5) * 50, y: toY + (Math.random() - 0.5) * 50 }
    ];

    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const point = this.cubicBezier(
        t,
        { x: fromX, y: fromY },
        controlPoints[0],
        controlPoints[1],
        { x: toX, y: toY }
      );

      await page.mouse.move(point.x, point.y);
      await new Promise(resolve => setTimeout(resolve, 10 + Math.random() * 20));
    }
  }

  static async readingJitter(page) {
    const scrollAmount = 50 + Math.random() * 100;
    const direction = Math.random() > 0.5 ? 1 : -1;
    
    await page.evaluate((amount, dir) => {
      window.scrollBy(0, amount * dir);
    }, scrollAmount, direction);

    await this.randomDelay(200, 800);
  }

  static async humanType(page, selector, text, options = {}) {
    const { minDelay = 50, maxDelay = 150, typoChance = 0.1 } = options;

    await page.click(selector);
    await this.randomDelay(100, 300);

    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      
      if (Math.random() < typoChance && i > 0) {
        const typoChar = String.fromCharCode(char.charCodeAt(0) + 1);
        await page.keyboard.type(typoChar);
        await this.randomDelay(minDelay, maxDelay);
        await page.keyboard.press('Backspace');
        await this.randomDelay(minDelay, maxDelay);
      }

      await page.keyboard.type(char);
      await this.randomDelay(minDelay, maxDelay);
    }
  }

  static async simulateReading(page, duration = 3000) {
    const startTime = Date.now();
    const endTime = startTime + duration;

    while (Date.now() < endTime) {
      await this.readingJitter(page);
      await this.randomDelay(500, 1500);
    }
  }
}
