import { useMemo } from 'react';
import Highcharts from 'highcharts';
import HighchartsReact from 'highcharts-react-official';
import type { MediaLibraryHistoricalDataPoint } from '@tracearr/shared';
import { ChartSkeleton } from '@/components/ui/skeleton';
import { formatBytes } from '@/lib/utils';

// Color palette for libraries
const LIBRARY_COLORS = [
  'hsl(var(--chart-1))', // Green - TV Shows
  'hsl(var(--chart-2))', // Blue - Movies
  'hsl(var(--chart-3))', // Purple - Anime
  'hsl(var(--chart-4))', // Orange - Music
  'hsl(var(--chart-5))', // Pink - Other
  'hsl(var(--primary))', // Primary color
  'hsl(var(--accent-foreground))',
];

interface LibraryGrowthChartProps {
  data: MediaLibraryHistoricalDataPoint[] | undefined;
  isLoading?: boolean;
  height?: number;
}

export function LibraryGrowthChart({ data, isLoading, height = 300 }: LibraryGrowthChartProps) {
  const options = useMemo<Highcharts.Options>(() => {
    if (!data || data.length === 0) {
      return {};
    }

    // Get unique library names from data
    const libraryNames = new Set<string>();
    data.forEach((point) => {
      point.libraries.forEach((lib) => {
        libraryNames.add(lib.libraryName);
      });
    });

    const uniqueLibraries = Array.from(libraryNames);

    // Build series for each library
    const series: Highcharts.SeriesAreaOptions[] = uniqueLibraries.map((libName, index) => ({
      type: 'area',
      name: libName,
      data: data.map((point) => {
        const lib = point.libraries.find((l) => l.libraryName === libName);
        return lib ? lib.size : 0;
      }),
      color: LIBRARY_COLORS[index % LIBRARY_COLORS.length],
      fillOpacity: 0.4,
    }));

    return {
      chart: {
        type: 'area',
        height,
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
        enabled: true,
        align: 'right',
        verticalAlign: 'top',
        layout: 'horizontal',
        itemStyle: {
          color: 'hsl(var(--foreground))',
        },
        itemHoverStyle: {
          color: 'hsl(var(--primary))',
        },
      },
      xAxis: {
        categories: data.map((d) => d.date),
        labels: {
          style: {
            color: 'hsl(var(--muted-foreground))',
          },
          formatter: function () {
            const categories = this.axis.categories;
            const categoryValue =
              typeof this.value === 'number' ? categories[this.value] : this.value;
            if (!categoryValue) return '';
            const date = new Date(categoryValue + 'T00:00:00');
            if (isNaN(date.getTime())) return '';
            return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
          },
          step: Math.ceil(data.length / 8),
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
        min: 0,
      },
      plotOptions: {
        area: {
          stacking: 'normal',
          marker: {
            enabled: false,
            states: {
              hover: {
                enabled: true,
                radius: 4,
              },
            },
          },
          lineWidth: 2,
          states: {
            hover: {
              lineWidth: 2,
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
        shared: true,
        formatter: function () {
          const points = this.points ?? [];
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const dateStr = (this as any).x as string;
          const date = new Date(dateStr + 'T00:00:00');
          const formattedDate = date.toLocaleDateString('en-US', {
            month: 'short',
            day: 'numeric',
            year: 'numeric',
          });

          let html = `<b>${formattedDate}</b><br/>`;
          let total = 0;
          points.forEach((point) => {
            const value = point.y ?? 0;
            total += value;
            html += `<span style="color:${point.color}">\u25CF</span> ${point.series.name}: ${formatBytes(value)}<br/>`;
          });
          html += `<b>Total: ${formatBytes(total)}</b>`;
          return html;
        },
      },
      series,
    };
  }, [data, height]);

  if (isLoading) {
    return <ChartSkeleton height={height} />;
  }

  if (!data || data.length === 0) {
    return (
      <div
        className="text-muted-foreground flex flex-col items-center justify-center rounded-lg border border-dashed p-4 text-center"
        style={{ height }}
      >
        <p className="font-medium">No historical data yet</p>
        <p className="text-muted-foreground/70 mt-1 text-xs">
          Daily snapshots are taken at 3:00 AM. Check back tomorrow to see growth trends.
        </p>
      </div>
    );
  }

  // If there's only one data point, show a helpful message
  if (data.length === 1) {
    return (
      <div
        className="text-muted-foreground flex flex-col items-center justify-center rounded-lg border border-dashed p-4 text-center"
        style={{ height }}
      >
        <p className="font-medium">Insufficient data for trends</p>
        <p className="text-muted-foreground/70 mt-1 text-xs">
          Need at least 2 days of data to show growth. First snapshot recorded today.
        </p>
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
