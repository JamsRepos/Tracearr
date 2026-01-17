import { useMemo } from 'react';
import Highcharts from 'highcharts';
import HighchartsReact from 'highcharts-react-official';
import type { MediaLibraryStats } from '@tracearr/shared';
import { ChartSkeleton } from '@/components/ui/skeleton';
import { formatBytes } from '@/lib/utils';

// Color palette for libraries
const LIBRARY_COLORS = [
  'hsl(var(--chart-1))', // Green
  'hsl(var(--chart-2))', // Blue
  'hsl(var(--chart-3))', // Purple
  'hsl(var(--chart-4))', // Orange
  'hsl(var(--chart-5))', // Pink
  'hsl(var(--primary))',
  'hsl(var(--accent-foreground))',
];

interface LibraryComparisonChartProps {
  libraries: MediaLibraryStats[] | undefined;
  isLoading?: boolean;
  height?: number;
}

export function LibraryComparisonChart({
  libraries,
  isLoading,
  height = 300,
}: LibraryComparisonChartProps) {
  const options = useMemo<Highcharts.Options>(() => {
    if (!libraries || libraries.length === 0) {
      return {};
    }

    // Sort libraries by size (largest first)
    const sortedLibraries = [...libraries].sort((a, b) => b.size - a.size);
    const maxSize = sortedLibraries[0]?.size ?? 1;

    return {
      chart: {
        type: 'bar',
        height: Math.max(height, sortedLibraries.length * 50 + 50),
        backgroundColor: 'transparent',
        style: {
          fontFamily: 'inherit',
        },
        reflow: true,
      },
      title: {
        text: undefined,
      },
      credits: {
        enabled: false,
      },
      legend: {
        enabled: false,
      },
      xAxis: {
        categories: sortedLibraries.map((lib) => lib.name),
        labels: {
          style: {
            color: 'hsl(var(--foreground))',
            fontSize: '12px',
          },
        },
        lineColor: 'hsl(var(--border))',
        tickColor: 'hsl(var(--border))',
      },
      yAxis: {
        title: {
          text: undefined,
        },
        labels: {
          style: {
            color: 'hsl(var(--muted-foreground))',
          },
          formatter: function () {
            return formatBytes(this.value as number, 0);
          },
        },
        gridLineColor: 'hsl(var(--border))',
        max: maxSize * 1.1, // Add 10% padding
      },
      plotOptions: {
        bar: {
          borderRadius: 4,
          dataLabels: {
            enabled: true,
            style: {
              color: 'hsl(var(--foreground))',
              textOutline: 'none',
            },
            formatter: function () {
              return formatBytes(this.y ?? 0);
            },
          },
        },
      },
      tooltip: {
        backgroundColor: 'hsl(var(--popover))',
        borderColor: 'hsl(var(--border))',
        style: {
          color: 'hsl(var(--popover-foreground))',
        },
        useHTML: true,
        formatter: function () {
          // Get the library from the point index
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const pointIndex =
            typeof (this as any).point?.index === 'number' ? (this as any).point.index : 0;
          const lib = sortedLibraries[pointIndex];

          if (!lib) return '';

          let html = `<div style="padding: 4px;">`;
          html += `<b>${lib.name}</b><br/>`;
          html += `<span style="color: hsl(var(--muted-foreground));">Size:</span> <b>${formatBytes(lib.size)}</b><br/>`;
          html += `<span style="color: hsl(var(--muted-foreground));">Items:</span> ${lib.itemCount.toLocaleString()}`;
          if (lib.episodeCount) {
            html += ` <span style="color: hsl(var(--muted-foreground));">(${lib.episodeCount.toLocaleString()} episodes)</span>`;
          }
          html += `<br/>`;
          html += `<span style="color: hsl(var(--muted-foreground));">Duration:</span> ${Math.round(lib.hours).toLocaleString()} hours`;
          html += `</div>`;
          return html;
        },
      },
      series: [
        {
          type: 'bar',
          name: 'Size',
          data: sortedLibraries.map((lib, index) => ({
            y: lib.size,
            color: LIBRARY_COLORS[index % LIBRARY_COLORS.length],
          })),
        },
      ],
    };
  }, [libraries, height]);

  if (isLoading) {
    return <ChartSkeleton height={height} />;
  }

  if (!libraries || libraries.length === 0) {
    return (
      <div
        className="text-muted-foreground flex items-center justify-center rounded-lg border border-dashed"
        style={{ height }}
      >
        No library data available
      </div>
    );
  }

  return (
    <HighchartsReact
      highcharts={Highcharts}
      options={options}
      containerProps={{ style: { width: '100%', height: '100%' } }}
    />
  );
}
