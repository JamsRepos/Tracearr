/**
 * Unit Conversion Utility Tests
 *
 * Tests the unit conversion functions from @tracearr/shared:
 * - kmToMiles: Convert kilometers to miles
 * - milesToKm: Convert miles to kilometers
 * - formatDistance: Format distance with unit label
 * - formatSpeed: Format speed with unit label
 * - getDistanceUnit: Get distance unit string
 * - getSpeedUnit: Get speed unit string
 * - toMetricDistance: Convert display value to internal metric
 * - fromMetricDistance: Convert internal metric to display value
 */

import { describe, it, expect } from 'vitest';
import {
  UNIT_CONVERSION,
  kmToMiles,
  milesToKm,
  formatDistance,
  formatSpeed,
  getDistanceUnit,
  getSpeedUnit,
  toMetricDistance,
  fromMetricDistance,
} from '@tracearr/shared';

describe('Unit Conversion Constants', () => {
  it('should have correct conversion factors', () => {
    expect(UNIT_CONVERSION.KM_TO_MILES).toBe(0.621371);
    expect(UNIT_CONVERSION.MILES_TO_KM).toBe(1.60934);
  });

  it('conversion factors should be approximate inverses', () => {
    // Converting 1 km to miles and back should give ~1 km
    const roundTrip = kmToMiles(1) * UNIT_CONVERSION.MILES_TO_KM;
    expect(roundTrip).toBeCloseTo(1, 4);
  });
});

describe('kmToMiles', () => {
  it('should convert 0 km to 0 miles', () => {
    expect(kmToMiles(0)).toBe(0);
  });

  it('should convert 1 km to approximately 0.621 miles', () => {
    expect(kmToMiles(1)).toBeCloseTo(0.621371, 5);
  });

  it('should convert 100 km to approximately 62.14 miles', () => {
    expect(kmToMiles(100)).toBeCloseTo(62.1371, 3);
  });

  it('should convert 1000 km to approximately 621.37 miles', () => {
    expect(kmToMiles(1000)).toBeCloseTo(621.371, 2);
  });

  it('should handle decimal values', () => {
    expect(kmToMiles(1.5)).toBeCloseTo(0.9320565, 5);
  });

  it('should handle negative values (edge case)', () => {
    expect(kmToMiles(-10)).toBeCloseTo(-6.21371, 4);
  });
});

describe('milesToKm', () => {
  it('should convert 0 miles to 0 km', () => {
    expect(milesToKm(0)).toBe(0);
  });

  it('should convert 1 mile to approximately 1.609 km', () => {
    expect(milesToKm(1)).toBeCloseTo(1.60934, 4);
  });

  it('should convert 62.14 miles to approximately 100 km', () => {
    expect(milesToKm(62.14)).toBeCloseTo(100, 0);
  });

  it('should handle decimal values', () => {
    expect(milesToKm(0.5)).toBeCloseTo(0.80467, 4);
  });
});

describe('formatDistance', () => {
  describe('metric system', () => {
    it('should format 0 km correctly', () => {
      expect(formatDistance(0, 'metric')).toBe('0 km');
    });

    it('should format integer km correctly', () => {
      expect(formatDistance(100, 'metric')).toBe('100 km');
    });

    it('should format km with decimals when specified', () => {
      expect(formatDistance(100.567, 'metric', 2)).toBe('100.57 km');
    });

    it('should round to 0 decimals by default', () => {
      expect(formatDistance(100.9, 'metric')).toBe('101 km');
    });

    it('should handle large distances', () => {
      expect(formatDistance(12500, 'metric')).toBe('12500 km');
    });
  });

  describe('imperial system', () => {
    it('should format 0 km as 0 mi', () => {
      expect(formatDistance(0, 'imperial')).toBe('0 mi');
    });

    it('should convert 100 km to approximately 62 mi', () => {
      expect(formatDistance(100, 'imperial')).toBe('62 mi');
    });

    it('should format with decimals when specified', () => {
      expect(formatDistance(100, 'imperial', 2)).toBe('62.14 mi');
    });

    it('should handle 1 km conversion', () => {
      expect(formatDistance(1, 'imperial', 2)).toBe('0.62 mi');
    });

    it('should handle large distances', () => {
      expect(formatDistance(1000, 'imperial')).toBe('621 mi');
    });
  });
});

describe('formatSpeed', () => {
  describe('metric system', () => {
    it('should format 0 km/h correctly', () => {
      expect(formatSpeed(0, 'metric')).toBe('0 km/h');
    });

    it('should format integer speeds correctly', () => {
      expect(formatSpeed(100, 'metric')).toBe('100 km/h');
    });

    it('should format speeds with decimals when specified', () => {
      expect(formatSpeed(100.567, 'metric', 1)).toBe('100.6 km/h');
    });

    it('should round to 0 decimals by default', () => {
      expect(formatSpeed(65.8, 'metric')).toBe('66 km/h');
    });

    it('should handle typical impossible travel speeds', () => {
      expect(formatSpeed(1500, 'metric')).toBe('1500 km/h');
    });
  });

  describe('imperial system', () => {
    it('should format 0 km/h as 0 mph', () => {
      expect(formatSpeed(0, 'imperial')).toBe('0 mph');
    });

    it('should convert 100 km/h to approximately 62 mph', () => {
      expect(formatSpeed(100, 'imperial')).toBe('62 mph');
    });

    it('should format with decimals when specified', () => {
      expect(formatSpeed(100, 'imperial', 1)).toBe('62.1 mph');
    });

    it('should handle 60 km/h (common speed limit)', () => {
      expect(formatSpeed(60, 'imperial')).toBe('37 mph');
    });

    it('should handle impossible travel speeds', () => {
      // 1500 km/h = ~932 mph (supersonic)
      expect(formatSpeed(1500, 'imperial')).toBe('932 mph');
    });
  });
});

describe('getDistanceUnit', () => {
  it('should return "km" for metric', () => {
    expect(getDistanceUnit('metric')).toBe('km');
  });

  it('should return "mi" for imperial', () => {
    expect(getDistanceUnit('imperial')).toBe('mi');
  });
});

describe('getSpeedUnit', () => {
  it('should return "km/h" for metric', () => {
    expect(getSpeedUnit('metric')).toBe('km/h');
  });

  it('should return "mph" for imperial', () => {
    expect(getSpeedUnit('imperial')).toBe('mph');
  });
});

describe('toMetricDistance', () => {
  describe('metric system', () => {
    it('should return the same value for metric', () => {
      expect(toMetricDistance(100, 'metric')).toBe(100);
    });

    it('should not convert 0', () => {
      expect(toMetricDistance(0, 'metric')).toBe(0);
    });

    it('should preserve decimal values', () => {
      expect(toMetricDistance(100.567, 'metric')).toBe(100.567);
    });
  });

  describe('imperial system', () => {
    it('should convert miles to km', () => {
      expect(toMetricDistance(62.14, 'imperial')).toBeCloseTo(100, 0);
    });

    it('should convert 0 miles to 0 km', () => {
      expect(toMetricDistance(0, 'imperial')).toBe(0);
    });

    it('should convert 1 mile to approximately 1.609 km', () => {
      expect(toMetricDistance(1, 'imperial')).toBeCloseTo(1.60934, 4);
    });
  });
});

describe('fromMetricDistance', () => {
  describe('metric system', () => {
    it('should return the same value for metric', () => {
      expect(fromMetricDistance(100, 'metric')).toBe(100);
    });

    it('should not convert 0', () => {
      expect(fromMetricDistance(0, 'metric')).toBe(0);
    });

    it('should preserve decimal values', () => {
      expect(fromMetricDistance(100.567, 'metric')).toBe(100.567);
    });
  });

  describe('imperial system', () => {
    it('should convert km to miles', () => {
      expect(fromMetricDistance(100, 'imperial')).toBeCloseTo(62.1371, 3);
    });

    it('should convert 0 km to 0 miles', () => {
      expect(fromMetricDistance(0, 'imperial')).toBe(0);
    });

    it('should convert 1.609 km to approximately 1 mile', () => {
      expect(fromMetricDistance(1.60934, 'imperial')).toBeCloseTo(1, 3);
    });
  });
});

describe('Round-trip conversions', () => {
  it('should preserve value through metric -> display -> metric for metric system', () => {
    const original = 150;
    const display = fromMetricDistance(original, 'metric');
    const restored = toMetricDistance(display, 'metric');
    expect(restored).toBe(original);
  });

  it('should approximately preserve value through metric -> display -> metric for imperial', () => {
    const original = 150;
    const display = fromMetricDistance(original, 'imperial');
    const restored = toMetricDistance(display, 'imperial');
    // Conversion factors are not exact inverses, so allow ~0.001% error
    expect(restored).toBeCloseTo(original, 2);
  });

  it('should handle typical rule threshold values', () => {
    // 100 km threshold -> display in miles -> back to km
    const thresholdKm = 100;
    const displayMiles = fromMetricDistance(thresholdKm, 'imperial');
    expect(displayMiles).toBeCloseTo(62.1371, 3);

    const backToKm = toMetricDistance(displayMiles, 'imperial');
    // Conversion factors are not exact inverses, so allow ~0.001% error
    expect(backToKm).toBeCloseTo(100, 2);
  });
});

describe('Real-world scenarios', () => {
  describe('impossible travel rule', () => {
    it('should format typical violation speed (1000 km/h)', () => {
      expect(formatSpeed(1000, 'metric')).toBe('1000 km/h');
      expect(formatSpeed(1000, 'imperial')).toBe('621 mph');
    });

    it('should format airplane-level speeds (900 km/h)', () => {
      expect(formatSpeed(900, 'metric')).toBe('900 km/h');
      expect(formatSpeed(900, 'imperial')).toBe('559 mph');
    });

    it('should format distance between cities (500 km)', () => {
      expect(formatDistance(500, 'metric')).toBe('500 km');
      expect(formatDistance(500, 'imperial')).toBe('311 mi');
    });
  });

  describe('distance threshold display', () => {
    it('should convert 50 km threshold for imperial users', () => {
      const thresholdKm = 50;
      const displayValue = fromMetricDistance(thresholdKm, 'imperial');
      expect(Math.round(displayValue)).toBe(31); // ~31 miles
    });

    it('should convert user input of 30 miles back to km', () => {
      const userInput = 30; // miles
      const storedValue = toMetricDistance(userInput, 'imperial');
      expect(storedValue).toBeCloseTo(48.28, 1); // ~48 km
    });
  });
});
