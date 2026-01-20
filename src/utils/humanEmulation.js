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
    const distance = Math.sqrt(Math.pow(toX - fromX, 2) + Math.pow(toY - fromY, 2));
    const steps = Math.max(20, Math.min(50, Math.floor(distance / 10) + Math.floor(Math.random() * 10)));
    
    const controlPoints = [
      { x: fromX + (Math.random() - 0.5) * 50, y: fromY + (Math.random() - 0.5) * 50 },
      { x: toX + (Math.random() - 0.5) * 50, y: toY + (Math.random() - 0.5) * 50 }
    ];

    let previousPoint = { x: fromX, y: fromY };
    
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
      
      const stepDistance = Math.sqrt(
        Math.pow(point.x - previousPoint.x, 2) + 
        Math.pow(point.y - previousPoint.y, 2)
      );
      
      const remainingDistance = Math.sqrt(
        Math.pow(toX - point.x, 2) + 
        Math.pow(toY - point.y, 2)
      );
      
      const progress = 1 - (remainingDistance / distance);
      
      let delay;
      if (progress < 0.1) {
        delay = 5 + Math.random() * 10;
      } else if (progress < 0.3) {
        delay = 8 + Math.random() * 12;
      } else if (progress < 0.7) {
        delay = 10 + Math.random() * 15;
      } else if (progress < 0.9) {
        delay = 15 + Math.random() * 20;
      } else {
        delay = 20 + Math.random() * 30;
      }
      
      await new Promise(resolve => setTimeout(resolve, delay));
      
      previousPoint = point;
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

    // Try to click with error handling
    try {
      await page.click(selector, { delay: 100 });
    } catch (clickError) {
      // If click fails, try JavaScript click
      try {
        await page.evaluate((sel) => {
          const el = document.querySelector(sel);
          if (el) {
            el.focus();
            el.click();
          }
        }, selector);
      } catch (jsClickError) {
        // If both fail, just focus the element
        await page.evaluate((sel) => {
          const el = document.querySelector(sel);
          if (el) el.focus();
        }, selector);
      }
    }
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
